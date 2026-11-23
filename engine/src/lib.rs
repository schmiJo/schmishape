//! The browser's way into CoreShape. Modelling goes through the same tools an agent uses, so the
//! UI and an AI share one API. The only additions are what a screen needs and a tool shouldn't
//! return as JSON: display meshes, an STL's bytes, and each parameter's current value.
//!
//! Meshes come from the session's own rebuild, so nothing is built twice.

use coreshape::{export, tessellate, v3, Aabb, Body, Frame, Mesh, TessParams, Vec3};
use coreshape_document::json::{self, Value};
use coreshape_document::Outcome;
use coreshape_mcp::{Server, Session};
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
extern "C" {
    fn sx_on_panic(p: *const u8, n: usize);
    /// How far a long call has got, as the kernel's progress JSON: `{"feature":3,"stage":"solids","done":120,"total":711}`.
    fn sx_progress(p: *const u8, n: usize);
}

struct Engine {
    session: Session,
    out: Vec<u8>,
    positions: Vec<f32>,
    normals: Vec<f32>,
    faces: Vec<u32>,
    indices: Vec<u32>,
    segments: Vec<f32>,
    segment_ids: Vec<u32>,
    info: String,
    table: [u32; 14],
    meshes: HashMap<usize, Meshed>,
    draft_meshes: HashMap<usize, Meshed>,
    boxes: HashMap<usize, (Arc<Body>, Aabb)>,
}

impl Engine {
    fn new() -> Engine {
        Engine {
            session: Session::new(PathBuf::from("/")),
            out: Vec::new(),
            positions: Vec::new(),
            normals: Vec::new(),
            faces: Vec::new(),
            indices: Vec::new(),
            segments: Vec::new(),
            segment_ids: Vec::new(),
            info: String::new(),
            table: [0; 14],
            meshes: HashMap::new(),
            draft_meshes: HashMap::new(),
            boxes: HashMap::new(),
        }
    }

    /// The model up to a position, or all of it. The session's own outcome is whatever was rebuilt last, which can be
    /// a rollback, so this asks for exactly what it wants. Features that haven't changed aren't built again.
    fn outcome(&mut self, upto: Option<usize>) -> Outcome {
        self.session.outcome_upto(upto)
    }

    fn body(&mut self, upto: Option<usize>) -> Option<Arc<Body>> {
        self.outcome(upto).body
    }

    fn fill_mesh(&mut self, upto: Option<usize>, draft: bool) -> Result<(usize, usize, String), String> {
        self.positions.clear();
        self.normals.clear();
        self.faces.clear();
        self.indices.clear();
        self.segments.clear();
        self.segment_ids.clear();
        let outcome = self.outcome(upto);
        let Some(body) = outcome.body.clone() else { return Ok((0, 0, "[]".to_string())) };
        let parts: Vec<(Arc<Body>, Option<Frame>, usize, usize)> = if outcome.bodies.is_empty() {
            vec![(body.clone(), None, 0, 0)]
        } else {
            outcome
                .bodies
                .iter()
                .map(|b| match &b.copy_of {
                    Some(c) => (c.body.clone(), Some(c.at), b.first_face, b.first_edge),
                    None => (b.body.clone(), None, b.first_face, b.first_edge),
                })
                .collect()
        };
        // The size sets how fine the mesh is. The whole's box took 20 s for a 711-part assembly, so it's put
        // together from each shape's, worked out once and moved to each copy.
        let mut whole = Aabb::EMPTY;
        let mut boxes: HashMap<usize, (Arc<Body>, Aabb)> = HashMap::new();
        for (source, at, _, _) in &parts {
            let key = Arc::as_ptr(source) as usize;
            let found = boxes.get(&key).or_else(|| self.boxes.get(&key).filter(|(b, _)| Arc::ptr_eq(b, source))).map(|(_, a)| *a);
            let aabb = found.unwrap_or_else(|| source.aabb());
            boxes.insert(key, (source.clone(), aabb));
            match at {
                None => whole.union(&aabb),
                Some(f) => {
                    for k in 0..8 {
                        let pick = |bit: usize, lo: f64, hi: f64| if k & bit == 0 { lo } else { hi };
                        let corner = v3(pick(1, aabb.min.x, aabb.max.x), pick(2, aabb.min.y, aabb.max.y), pick(4, aabb.min.z, aabb.max.z));
                        whole.add(f.to_world(corner));
                    }
                }
            }
        }
        self.boxes = boxes;
        let size = whole.diagonal();
        // The kernel's display preset turns a small circle into 15 sides, which shows at CAD zoom levels.
        let params = if draft { TessParams::draft_for_size(size) } else { TessParams { chord: (size * 5e-4).max(1e-4), angle: 11f64.to_radians() } };
        // Each body is meshed on its own, and a body that's a rigid copy of another, as every use of a part in a STEP
        // assembly is, takes that one's mesh, moved. A 711-part assembly is 2,218 bodies of 273 shapes: meshed as one,
        // it ran a browser out of memory. Meshes are kept between calls while their body stays the same, so an edit
        // elsewhere meshes only what it changed.
        let cache = if draft { &mut self.draft_meshes } else { &mut self.meshes };
        let mut kept: HashMap<usize, Meshed> = HashMap::new();
        for (source, at, first_face, first_edge) in parts {
            let key = Arc::as_ptr(&source) as usize;
            let meshed = match kept.get(&key).or_else(|| cache.get(&key).filter(|m| m.chord == params.chord && Arc::ptr_eq(&m.body, &source))) {
                Some(m) => m.clone(),
                None => {
                    let mesh = tessellate(&source, &params).map_err(|e| e.to_string())?;
                    // Closed surfaces are split into half faces, for robustness. The seam between two pieces of one
                    // surface isn't a real edge: it would only clutter the view and offer a fillet that means nothing.
                    let uses = source.edge_uses();
                    let seam = (0..source.edges.len())
                        .map(|e| matches!(uses[e].as_slice(), [a, b] if source.faces[a.0].surface == source.faces[b.0].surface))
                        .collect();
                    Meshed { body: source.clone(), chord: params.chord, mesh: Arc::new(mesh), seam: Arc::new(seam) }
                }
            };
            kept.insert(key, meshed.clone());
            let mesh = &meshed.mesh;
            let point = |p: Vec3| at.map_or(p, |f| f.to_world(p));
            let dir = |d: Vec3| at.map_or(d, |f| f.dir_to_world(d));
            let base = (self.positions.len() / 3) as u32;
            for &p in &mesh.positions {
                let p = point(p);
                self.positions.extend_from_slice(&[p.x as f32, p.y as f32, p.z as f32]);
            }
            for &n in &mesh.normals {
                let n = dir(n);
                self.normals.extend_from_slice(&[n.x as f32, n.y as f32, n.z as f32]);
            }
            // Vertices aren't shared between faces, so each vertex has exactly one.
            let start = self.faces.len();
            self.faces.resize(start + mesh.positions.len(), 0);
            for (t, &f) in mesh.triangles.iter().zip(&mesh.face_of_triangle) {
                for &v in t {
                    self.faces[start + v as usize] = f + first_face as u32;
                    self.indices.push(base + v);
                }
            }
            for (e, line) in mesh.edge_lines.iter().enumerate() {
                if meshed.seam[e] {
                    continue;
                }
                for w in line.windows(2) {
                    let (a, b) = (point(w[0]), point(w[1]));
                    self.segments.extend_from_slice(&[a.x as f32, a.y as f32, a.z as f32, b.x as f32, b.y as f32, b.z as f32]);
                    self.segment_ids.push((e + first_edge) as u32);
                }
            }
        }
        *cache = kept;
        Ok((body.faces.len(), body.edges.len(), parts_json(&outcome, &body)))
    }
}

/// One body's display mesh, kept while the body is the same one, at the same fineness.
#[derive(Clone)]
struct Meshed {
    body: Arc<Body>,
    chord: f64,
    mesh: Arc<Mesh>,
    /// Edges that are only the seam of a closed surface, not drawn.
    seam: Arc<Vec<bool>>,
}

/// Each body, as `[{"name": "f3", "label": "Wheel hub", "sheet": false, "faces": [...], "edges": [...]}]`, oldest first. The kernel puts them
/// side by side in one body, so a part's faces and edges are a run of the whole's.
fn parts_json(outcome: &Outcome, whole: &Body) -> String {
    let runs = |starts: Vec<usize>, total: usize| -> Vec<(usize, usize)> {
        (0..starts.len()).map(|i| (starts[i], starts.get(i + 1).copied().unwrap_or(total))).collect()
    };
    let faces = runs(outcome.bodies.iter().map(|b| b.first_face).collect(), whole.faces.len());
    let edges = runs(outcome.bodies.iter().map(|b| b.first_edge).collect(), whole.edges.len());
    let list = |(a, b): (usize, usize)| (a..b).map(|i| i.to_string()).collect::<Vec<_>>().join(",");
    let items: Vec<String> = outcome
        .bodies
        .iter()
        .enumerate()
        .map(|(i, b)| {
            // A STEP part's own name, such as "Wheel hub", for the parts list to show.
            let label = b.name.as_ref().map_or(String::new(), |n| format!(",\"label\":{}", Value::str(n.clone()).to_text()));
            format!("{{\"name\":\"{}\"{label},\"sheet\":{},\"faces\":[{}],\"edges\":[{}]}}", b.id.text(), b.body.sheet, list(faces[i]), list(edges[i]))
        })
        .collect();
    format!("[{}]", items.join(","))
}

thread_local! {
    static ENGINE: RefCell<Engine> = RefCell::new(Engine::new());
}

fn answer(e: &mut Engine, bytes: Vec<u8>) -> *const u8 {
    e.out = bytes;
    e.out.as_ptr()
}

#[no_mangle]
pub extern "C" fn sx_init() {
    #[cfg(target_arch = "wasm32")]
    std::panic::set_hook(Box::new(|info| {
        let message = info.to_string();
        unsafe { sx_on_panic(message.as_ptr(), message.len()) };
    }));
    // The kernel calls this at most once per whole percent of a stage, so a long STEP import tells the page a few
    // hundred times, through the worker, while the call itself is still running.
    #[cfg(target_arch = "wasm32")]
    coreshape::progress::set_hook(|p| {
        let json = p.json();
        unsafe { sx_progress(json.as_ptr(), json.len()) };
    });
}

#[no_mangle]
pub extern "C" fn sx_alloc(n: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(n);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// Length of the answer the last call returned.
#[no_mangle]
pub extern "C" fn sx_out_len() -> usize {
    ENGINE.with(|e| e.borrow().out.len())
}

/// Calls a tool. Takes ownership of `{"name": ..., "arguments": {...}}`, allocated by `sx_alloc`.
///
/// # Safety
/// `p` must come from `sx_alloc(n)` and hold `n` initialised bytes.
#[no_mangle]
pub unsafe extern "C" fn sx_call(p: *mut u8, n: usize) -> *const u8 {
    let text = String::from_utf8_lossy(&Vec::from_raw_parts(p, n, n)).into_owned();
    ENGINE.with(|e| {
        let mut e = e.borrow_mut();
        let result = match json::parse(&text) {
            Ok(message) => {
                let name = message.get("name").and_then(Value::as_str).unwrap_or("").to_string();
                let empty = Value::Obj(Vec::new());
                e.session.call_safely(&name, message.get("arguments").unwrap_or(&empty))
            }
            Err(why) => Value::obj(vec![
                ("content", Value::Arr(vec![Value::obj(vec![("type", Value::str("text")), ("text", Value::str(format!("not valid JSON: {why}")))])])),
                ("isError", Value::Bool(true)),
            ]),
        };
        answer(&mut e, result.to_text().into_bytes())
    })
}

/// The MCP tool list, with each tool's description and schema, ready to offer to a model.
#[no_mangle]
pub extern "C" fn sx_tools() -> *const u8 {
    let listed = Server::new(PathBuf::from("/"))
        .handle_line(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}"#)
        .unwrap_or_default();
    ENGINE.with(|e| answer(&mut e.borrow_mut(), listed.into_bytes()))
}

/// Every parameter's value as a number, or `{"error": ...}`. The sketch solver wants numbers.
#[no_mangle]
pub extern "C" fn sx_env() -> *const u8 {
    ENGINE.with(|e| {
        let mut e = e.borrow_mut();
        let found = e.session.document().environment().map_err(|x| x.to_string());
        let value = match found {
            Ok(env) => Value::Obj(env.into_iter().map(|(k, v)| (k, Value::Num(v))).collect()),
            Err(why) => Value::obj(vec![("error", Value::str(why))]),
        };
        answer(&mut e, value.to_text().into_bytes())
    })
}

/// Meshes the solid for display. `upto` below zero means the whole history. Returns seven
/// `(pointer, length)` pairs: positions, normals, a face per vertex, triangle indices, edge segments,
/// an edge per segment, and a JSON info string. Indices match `faces_list` and `edges_list`.
#[no_mangle]
pub extern "C" fn sx_mesh(upto: i32, draft: i32) -> *const u32 {
    ENGINE.with(|e| {
        let mut e = e.borrow_mut();
        let e = &mut *e;
        let upto = (upto >= 0).then_some(upto as usize);
        e.info = match e.fill_mesh(upto, draft != 0) {
            Ok((faces, edges, parts)) => format!("{{\"ok\":true,\"faces\":{faces},\"edges\":{edges},\"parts\":{parts}}}"),
            Err(why) => Value::obj(vec![("ok", Value::Bool(false)), ("error", Value::str(why))]).to_text(),
        };
        e.table = [
            e.positions.as_ptr() as u32,
            e.positions.len() as u32,
            e.normals.as_ptr() as u32,
            e.normals.len() as u32,
            e.faces.as_ptr() as u32,
            e.faces.len() as u32,
            e.indices.as_ptr() as u32,
            e.indices.len() as u32,
            e.segments.as_ptr() as u32,
            e.segments.len() as u32,
            e.segment_ids.as_ptr() as u32,
            e.segment_ids.len() as u32,
            e.info.as_ptr() as u32,
            e.info.len() as u32,
        ];
        e.table.as_ptr()
    })
}

/// The solid as binary STL, at export quality. `sx_out_len` of zero means there's no solid.
#[no_mangle]
pub extern "C" fn sx_stl() -> *const u8 {
    ENGINE.with(|e| {
        let mut e = e.borrow_mut();
        let bytes = match e.body(None) {
            Some(body) => tessellate(&body, &TessParams::for_size(body.aabb().diagonal())).map(|m| export::stl::write_binary(&m, "model")).unwrap_or_default(),
            _ => Vec::new(),
        };
        answer(&mut e, bytes)
    })
}


/// Base64, for a PDF's or PNG's bytes inside a JSON answer.
fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            s.push(if i <= c.len() { T[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    s
}

fn vec3_of(v: Option<&Value>) -> Result<Vec3, String> {
    match v.and_then(Value::as_array) {
        Some([x, y, z]) => match (x.as_f64(), y.as_f64(), z.as_f64()) {
            (Some(x), Some(y), Some(z)) => Ok(v3(x, y, z)),
            _ => Err("a point is [x, y, z]".into()),
        },
        _ => Err("a point is [x, y, z]".into()),
    }
}

// Part Studios an assembly drawing reads its parts from, by their file's text, rebuilt once and kept while it's the same.
thread_local! {
    static STUDIOS: RefCell<Vec<(String, coreshape_document::Document)>> = const { RefCell::new(Vec::new()) };
}

/// Runs `f` on the Part Studio saved as `text`, opened once and kept while it's the same, so a drawing of it rebuilds only
/// what changed.
fn with_studio<T>(text: &str, f: impl FnOnce(&mut coreshape_document::Document) -> Result<T, String>) -> Result<T, String> {
    STUDIOS.with(|s| {
        let mut s = s.borrow_mut();
        let i = match s.iter().position(|(t, _)| t == text) {
            Some(i) => i,
            None => {
                if s.len() >= 8 {
                    s.remove(0);
                }
                s.push((text.to_string(), coreshape_document::Document::load_text(text).map_err(|x| x.to_string())?));
                s.len() - 1
            }
        };
        f(&mut s[i].1)
    })
}

/// An engineering drawing, laid out by the kernel's drawing crate and written as `format` (svg, dxf, pdf or png).
///
/// Of a Part Studio: `{"drawing": {...}, "doc": "<.coreshape text>", "body": "f2"}`, without `body` for all its parts,
/// and without `doc` for the one open in the session. Its dimensions' points can
/// be sketch points or corners, looked up in a copy of the document so the session is left as it is. Of an assembly:
/// `{"drawing": {...}, "parts": [{"doc": "<.coreshape text>", "body": "f2", "at": {"origin", "x", "y", "z"}}]}`, whose
/// dimensions take places only. Answers `{"ok": true, "data", "scale", "notes", "width", "height"}`, with a PDF's or
/// PNG's bytes in base64, or `{"ok": false, "error"}`.
fn drawing(e: &mut Engine, args: &Value) -> Result<Value, String> {
    use coreshape_drawing::{out, page, Drawing};
    let spec = args.get("drawing").ok_or("\"drawing\" is needed")?;
    let d = Drawing::from_json(spec).map_err(|x| x.to_string())?;
    let format = args.get("format").and_then(Value::as_str).unwrap_or("svg");
    let made = if let Some(parts) = args.get("parts").and_then(Value::as_array) {
        let mut moved = Vec::new();
        for p in parts {
            let text = p.get("doc").and_then(Value::as_str).ok_or("each part needs its Part Studio's \"doc\"")?;
            let name = p.get("body").and_then(Value::as_str).ok_or("each part needs its \"body\"")?;
            let id = coreshape_document::BodyId::parse(name).map_err(|x| x.to_string())?;
            let at = p.get("at").ok_or("each part needs \"at\"")?;
            let frame = Frame { origin: vec3_of(at.get("origin"))?, x: vec3_of(at.get("x"))?, y: vec3_of(at.get("y"))?, z: vec3_of(at.get("z"))? };
            let body = with_studio(text, |doc| {
                let outcome = doc.rebuild(None);
                let found = outcome.find_body(id).ok_or_else(|| format!("part {name} isn't there now"))?;
                Ok(found.body.transformed(&frame))
            })?;
            moved.push(body);
        }
        if moved.is_empty() {
            return Err("the assembly has no parts to draw".into());
        }
        let list: Vec<&Body> = moved.iter().collect();
        let whole = Body::side_by_side(&list);
        page(&d, &whole, &|_| Err(coreshape::Error::InvalidInput("a drawing of an assembly takes its dimensions' points as places, [x, y, z]".into()))).map_err(|x| x.to_string())
    } else {
        let draw = |doc: &mut coreshape_document::Document| -> Result<coreshape_drawing::Page, String> {
            let outcome = doc.rebuild(None);
            let body: Body = match args.get("body").and_then(Value::as_str) {
                Some(name) => {
                    let id = coreshape_document::BodyId::parse(name).map_err(|x| x.to_string())?;
                    outcome.find_body(id).ok_or_else(|| format!("part {name} isn't there now"))?.body.as_ref().clone()
                }
                None => outcome.body.as_ref().ok_or("there are no parts to draw")?.as_ref().clone(),
            };
            let doc = RefCell::new(doc);
            page(&d, &body, &|v| {
                let r = coreshape_document::read_point_ref(v)?;
                doc.borrow_mut().locate_point(&r)
            })
            .map_err(|x| x.to_string())
        };
        match args.get("doc").and_then(Value::as_str) {
            Some(text) => with_studio(text, draw),
            None => draw(&mut e.session.document().clone()),
        }
    }?;
    let data = match format {
        "svg" => Value::str(out::svg(&made)),
        "dxf" => Value::str(out::dxf(&made)),
        "pdf" => Value::str(base64(&out::pdf(&made))),
        "png" => {
            let dpi = args.get("dpi").and_then(Value::as_f64).filter(|d| (10.0..=1200.0).contains(d)).unwrap_or(150.0);
            Value::str(base64(&out::png(&made, dpi / 25.4)))
        }
        other => return Err(format!("unknown format \"{other}\"; expected svg, dxf, pdf or png")),
    };
    Ok(Value::obj(vec![
        ("ok", Value::Bool(true)),
        ("data", data),
        ("scale", Value::str(coreshape_drawing::format_scale(made.scale))),
        ("width", Value::Num(made.width)),
        ("height", Value::Num(made.height)),
        ("notes", Value::Arr(made.notes.iter().map(Value::str).collect())),
    ]))
}

/// Draws an engineering drawing. Takes ownership of its JSON arguments, allocated by `sx_alloc`; see [`drawing`].
///
/// # Safety
/// `p` must come from `sx_alloc(n)` and hold `n` initialised bytes.
#[no_mangle]
pub unsafe extern "C" fn sx_drawing(p: *mut u8, n: usize) -> *const u8 {
    let text = String::from_utf8_lossy(&Vec::from_raw_parts(p, n, n)).into_owned();
    ENGINE.with(|e| {
        let mut e = e.borrow_mut();
        let result = json::parse(&text).map_err(|w| format!("not valid JSON: {w}")).and_then(|args| drawing(&mut e, &args));
        let value = result.unwrap_or_else(|why| Value::obj(vec![("ok", Value::Bool(false)), ("error", Value::str(why))]));
        answer(&mut e, value.to_text().into_bytes())
    })
}

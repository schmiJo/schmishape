// The assembly solver on its own, against answers worked out by hand. Usage: node scripts/test-assembly-solver.mjs
import { registerHooks } from 'node:module';

// The source imports without extensions, as the bundler wants. Node needs them spelled out.
registerHooks({
  resolve(specifier, context, next) {
    if (/^\.\.?\//.test(specifier) && !/\.\w+$/.test(specifier)) return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});

const { adjustedFrame, apply, dragTo, freedom, IDENTITY, mateFrames, MATE_DOF, snapFirst, snapSecond, solve, symEig, tangentFreedom } = await import('../src/assembly/solver.ts');

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}${detail ? `  (${detail})` : ''}`); }
  else { failures.push(name); console.log(`  FAIL ${name}  ${detail}`); }
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const nearV = (a, b, tol = 1e-6) => a.every((v, i) => near(v, b[i], tol));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const rotate = (q, v) => apply({ p: [0, 0, 0], q }, v);
const sameTurn = (a, b, tol = 1e-6) => Math.abs(Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) - 1) < tol;

const Z = { o: [0, 0, 0], x: [1, 0, 0], z: [0, 0, 1] };
const frame = (o, z = [0, 0, 1], x = [1, 0, 0]) => ({ o, x, z });
const body = (id, fixed = false, p = [0, 0, 0], q = [0, 0, 0, 1], extra = {}) => ({ id, fixed, pose: { p, q }, size: 10, ...extra });
const mate = (id, type, a, b, fa, fb, extra = {}) => ({ id, name: id, type, a, b, fa, fb, ...extra });
const withPoses = (bodies, poses) => bodies.map((b) => ({ ...b, pose: poses.get(b.id) ?? b.pose }));
const axisAngle = (axis, deg) => { const a = (deg * Math.PI) / 180 / 2; return [axis[0] * Math.sin(a), axis[1] * Math.sin(a), axis[2] * Math.sin(a), Math.cos(a)]; };

console.log('eigenvalues');
{
  const { values, vectors } = symEig(new Float64Array([2, 1, 1, 2]), 2);
  check('a 2 by 2 by hand', near(Math.min(...values), 1) && near(Math.max(...values), 3));
  check('with unit vectors', near(Math.hypot(vectors[0], vectors[2]), 1));
}

console.log('freedom by mate type: a free part mated to a fixed one');
for (const [type, want] of Object.entries({ fastened: 0, revolute: 1, slider: 1, planar: 3, cylindrical: 2, 'pin-slot': 2, ball: 3, parallel: 4 })) {
  const bodies = [body('A', true), body('B')];
  const r = solve(bodies, [mate('m', type, 'A', 'B', Z, Z)]);
  check(`${type} leaves ${want}`, r.dof === want && r.failed.length === 0 && MATE_DOF[type] === want, `${r.dof}`);
}
check('a free part alone has 6', freedom([body('A')], []) === 6);
check('a fixed part alone has 0', freedom([body('A', true)], []) === 0);
{
  const r = solve([body('A'), body('B')], [mate('m', 'fastened', 'A', 'B', Z, Z)]);
  check('two free parts fastened have 6 between them', r.dof === 6, `${r.dof}`);
}

console.log('solving moves parts as little as it can');
{
  const bodies = [body('A', true), body('B', false, [3, 4, 5]), body('C', false, [50, 50, 50])];
  const r = solve(bodies, [mate('m', 'ball', 'A', 'B', frame([10, 0, 0]), Z)]);
  check('the connectors meet', nearV(r.poses.get('B').p, [10, 0, 0]) || dist(apply(r.poses.get('B'), [0, 0, 0]), [10, 0, 0]) < 1e-6, JSON.stringify(r.poses.get('B').p));
  check('an unmated part stays put', nearV(r.poses.get('C').p, [50, 50, 50]) && r.dof === 3 + 6, `${r.dof}`);
  check('a fixed part stays put', nearV(r.poses.get('A').p, [0, 0, 0]));
}
{
  const bodies = [body('A', false, [0, 0, 0]), body('B', false, [10, 0, 0])];
  const r = solve(bodies, [mate('m', 'ball', 'A', 'B', Z, Z)]);
  const a = r.poses.get('A').p, b = r.poses.get('B').p;
  check('two free parts meet halfway', near(a[0], 5, 1e-5) && near(b[0], 5, 1e-5), `${a[0]} ${b[0]}`);
  const l = solve(bodies, [mate('m', 'ball', 'A', 'B', Z, Z)], { light: ['B'] });
  check('a light part does nearly all of the moving', l.poses.get('A').p[0] < 0.01 && near(l.poses.get('B').p[0], l.poses.get('A').p[0], 1e-6), `${l.poses.get('A').p[0]}`);
}
{
  const r = solve([body('A', true), body('B', false, [0, 0, 0], axisAngle([1, 0, 0], 180))], [mate('m', 'revolute', 'A', 'B', Z, Z)]);
  check('axes that start opposite still come round', r.failed.length === 0 && r.residual < 1e-6 && dot(rotate(r.poses.get('B').q, [0, 0, 1]), [0, 0, 1]) > 0.999999, `${r.residual}`);
}
{
  const m = mate('m', 'revolute', 'A', 'B', frame([1, 2, 3], [0, 1, 0]), frame([4, 5, 6], [1, 0, 0], [0, 0, 1]));
  const bodies = [body('A', true, [7, 0, 0], axisAngle([0, 0, 1], 30)), body('B', false, [-3, 9, 1], axisAngle([1, 1, 0].map((v) => v / Math.SQRT2), 70))];
  const r = solve(bodies, [m]);
  const f = mateFrames(m, r.poses);
  check('frames in any direction meet from anywhere', r.failed.length === 0 && dist(f.a.o, f.b.o) < 1e-6 && dot(f.a.z, f.b.z) > 0.9999999, `${dist(f.a.o, f.b.o)}`);
}

console.log('flip and quarter turns');
{
  const f = adjustedFrame(frame([0, 0, 0]), true);
  check('flip turns Z over and keeps X', nearV(f.z, [0, 0, -1]) && nearV(f.x, [1, 0, 0]));
  const q = adjustedFrame(frame([0, 0, 0]), false, 1);
  check('a quarter turn takes X to Y', nearV(q.x, [0, 1, 0]) && nearV(q.z, [0, 0, 1]));
  const m = mate('m', 'fastened', 'A', 'B', Z, Z, { flip: true });
  const r = solve([body('A', true), body('B')], [m]);
  check('a flipped mate turns the part over', dot(rotate(r.poses.get('B').q, [0, 0, 1]), [0, 0, 1]) < -0.999999, JSON.stringify(r.poses.get('B').q));
}

console.log('snapping a connector straight there');
{
  const m = mate('m', 'fastened', 'A', 'B', frame([1, 1, 1], [0, 1, 0]), frame([5, 0, 0], [1, 0, 0], [0, 1, 0]));
  const poseB = { p: [10, 0, 0], q: axisAngle([0, 0, 1], 40) };
  const placed = new Map([['A', snapFirst(m, poseB)], ['B', poseB]]);
  const f = mateFrames(m, placed);
  check('the first part lands exactly on the second', dist(f.a.o, f.b.o) < 1e-9 && dot(f.a.z, f.b.z) > 1 - 1e-12 && dot(f.a.x, f.b.x) > 1 - 1e-12);
  const poseA = { p: [-2, 7, 1], q: axisAngle([0, 1, 0], 25) };
  const other = new Map([['A', poseA], ['B', snapSecond(m, poseA)]]);
  const g = mateFrames(m, other);
  check('and the second on the first', dist(g.a.o, g.b.o) < 1e-9 && dot(g.a.z, g.b.z) > 1 - 1e-12 && dot(g.a.x, g.b.x) > 1 - 1e-12);
}

console.log('a free drag');
{
  const bodies = [body('B', false, [1, 2, 3], axisAngle([0, 0, 1], 25))];
  const poses = dragTo(bodies, [], { kind: 'point', body: 'B', local: [4, 0, 0], target: [20, 20, 20] });
  const b = poses.get('B');
  check('the grabbed point reaches the pointer', dist(apply(b, [4, 0, 0]), [20, 20, 20]) < 1e-6, JSON.stringify(b.p));
  check('and the part doesn’t turn', sameTurn(b.q, bodies[0].pose.q));
  check('a fixed part doesn’t move', dragTo([body('B', true)], [], { kind: 'point', body: 'B', local: [0, 0, 0], target: [1, 1, 1] }) === null);
}

console.log('a revolute only swings');
{
  const m = mate('r', 'revolute', 'A', 'B', frame([10, 0, 0]), Z);
  const placed = solve([body('A', true), body('B', false, [10, 0, 0])], [m]);
  check('it starts met', placed.failed.length === 0 && placed.dof === 1);
  const bodies = withPoses([body('A', true), body('B')], placed.poses);
  // Grab it 5 along X, and pull straight up in Y.
  const poses = dragTo(bodies, [m], { kind: 'point', body: 'B', local: [5, 0, 0], target: [10, 5, 0] });
  const b = poses.get('B');
  const f = mateFrames(m, poses);
  check('the pivot stays where it was', dist(f.b.o, [10, 0, 0]) < 1e-6, JSON.stringify(f.b.o));
  check('the axis stays along Z', dot(f.b.z, [0, 0, 1]) > 1 - 1e-9);
  check('it turned a quarter', near(dot(rotate(b.q, [1, 0, 0]), [0, 1, 0]), 1, 1e-6), JSON.stringify(rotate(b.q, [1, 0, 0])));
  check('the grabbed point got there', dist(apply(b, [5, 0, 0]), [10, 5, 0]) < 1e-5);
  const far = dragTo(bodies, [m], { kind: 'point', body: 'B', local: [5, 0, 0], target: [10, 50, 0] });
  check('a pull too far goes as far as it can, still on its circle', near(dist(apply(far.get('B'), [5, 0, 0]), [10, 0, 0]), 5, 1e-6), `${dist(apply(far.get('B'), [5, 0, 0]), [10, 0, 0])}`);
  check('and points the way it was pulled', near(dot(rotate(far.get('B').q, [1, 0, 0]), [0, 1, 0]), 1, 1e-4));
  const lift = dragTo(bodies, [m], { kind: 'point', body: 'B', local: [5, 0, 0], target: [15, 0, 30] });
  check('pulling along the axis does nothing', lift === null || dist(apply(lift.get('B'), [5, 0, 0]), [15, 0, 0]) < 1e-6);
  // A wheel spun by its rim, with its center right on the axis.
  const wheel = withPoses([body('A', true), body('W', false, [0, 0, 0], [0, 0, 0, 1], { center: [0, 0, 0] })], new Map());
  const w = mate('w', 'revolute', 'A', 'W', Z, Z);
  const spun = dragTo(wheel, [w], { kind: 'point', body: 'W', local: [5, 0, 0], target: [0, 5, 0] });
  check('a wheel spins from its rim', near(dot(rotate(spun.get('W').q, [1, 0, 0]), [0, 1, 0]), 1, 1e-6), JSON.stringify(spun.get('W').q));
}

console.log('a slider only slides');
{
  const m = mate('s', 'slider', 'A', 'B', Z, Z);
  const bodies = [body('A', true), body('B')];
  const poses = dragTo(bodies, [m], { kind: 'point', body: 'B', local: [3, 0, 0], target: [13, 9, 7] });
  const b = poses.get('B');
  check('it moves only along Z', nearV(b.p, [0, 0, 7], 1e-6), JSON.stringify(b.p));
  check('without turning', sameTurn(b.q, [0, 0, 0, 1]));
  const turned = dragTo(bodies, [m], { kind: 'pose', body: 'B', pose: { p: [0, 0, 0], q: axisAngle([0, 0, 1], 30) } });
  check('and a request to turn is refused', sameTurn(turned.get('B').q, [0, 0, 0, 1]), JSON.stringify(turned.get('B').q));
}

console.log('the other types move as they should');
{
  const drag = (type, target) => dragTo([body('A', true), body('B')], [mate('m', type, 'A', 'B', Z, Z)], { kind: 'point', body: 'B', local: [0, 0, 0], target }).get('B');
  check('cylindrical slides along Z', nearV(drag('cylindrical', [4, 5, 6]).p, [0, 0, 6], 1e-6));
  check('planar slides in X and Y, not Z', nearV(drag('planar', [4, 5, 6]).p, [4, 5, 0], 1e-6));
  check('pin slot slides in X only', nearV(drag('pin-slot', [4, 5, 6]).p, [4, 0, 0], 1e-6));
  check('parallel slides anywhere', nearV(drag('parallel', [4, 5, 6]).p, [4, 5, 6], 1e-6));
  check('ball can’t slide', nearV(drag('ball', [4, 5, 6]).p, [0, 0, 0], 1e-6));
  const ball = dragTo([body('A', true), body('B')], [mate('m', 'ball', 'A', 'B', Z, Z)], { kind: 'point', body: 'B', local: [5, 0, 0], target: [0, 0, 5] }).get('B');
  check('ball swings any way', dist(apply(ball, [5, 0, 0]), [0, 0, 5]) < 1e-5, JSON.stringify(apply(ball, [5, 0, 0])));
  const par = mate('m', 'parallel', 'A', 'B', Z, Z);
  const tilted = dragTo([body('A', true), body('B')], [par], { kind: 'pose', body: 'B', pose: { p: [0, 0, 0], q: axisAngle([1, 0, 0], 45) } }).get('B');
  check('parallel won’t tilt', dot(rotate(tilted.q, [0, 0, 1]), [0, 0, 1]) > 1 - 1e-9);
  const spun = dragTo([body('A', true), body('B')], [par], { kind: 'pose', body: 'B', pose: { p: [0, 0, 0], q: axisAngle([0, 0, 1], 45) } }).get('B');
  check('but it will spin about Z', sameTurn(spun.q, axisAngle([0, 0, 1], 45), 1e-6), JSON.stringify(spun.q));
  const noSpin = dragTo([body('A', true), body('B')], [mate('m', 'planar', 'A', 'B', Z, Z)], { kind: 'point', body: 'B', local: [5, 0, 0], target: [15, 3, 0] }).get('B');
  check('a planar drag translates rather than turns', sameTurn(noSpin.q, [0, 0, 0, 1], 1e-6) && nearV(noSpin.p, [10, 3, 0], 1e-6), JSON.stringify(noSpin));
}

console.log('a fastened pair moves as one');
{
  const m = mate('f', 'fastened', 'A', 'B', frame([10, 0, 0]), Z);
  const placed = solve([body('A'), body('B', false, [10, 0, 0])], [m]);
  const bodies = withPoses([body('A'), body('B')], placed.poses);
  const relative = (ps) => { const a = ps.get('A'), b = ps.get('B'); return [b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]]; };
  const before = relative(placed.poses);
  const poses = dragTo(bodies, [m], { kind: 'point', body: 'A', local: [0, 0, 0], target: [5, 5, 5] });
  check('dragging one brings the other', dist(apply(poses.get('A'), [0, 0, 0]), [5, 5, 5]) < 1e-6);
  check('exactly as far', nearV(relative(poses), before, 1e-6), JSON.stringify(relative(poses)));
  check('and fastened to something fixed it can’t move', (() => {
    const p = dragTo([body('A', true), body('B', false, [10, 0, 0])], [m], { kind: 'point', body: 'B', local: [0, 0, 0], target: [99, 0, 0] });
    return !p || nearV(p.get('B').p, [10, 0, 0], 1e-6);
  })());
}

console.log('a chain of two revolutes');
{
  const r1 = mate('r1', 'revolute', 'A', 'B', Z, Z);
  const r2 = mate('r2', 'revolute', 'B', 'C', frame([10, 0, 0]), Z);
  const placed = solve([body('A', true), body('B'), body('C', false, [10, 0, 0])], [r1, r2]);
  check('it has two freedoms', placed.failed.length === 0 && placed.dof === 2, `${placed.dof}`);
  const bodies = withPoses([body('A', true), body('B'), body('C')], placed.poses);
  // The tip of the second arm, 10 past the elbow, pulled somewhere both arms can reach: 10 and 10 reach (10, 10).
  let current = bodies;
  let poses;
  for (const t of [[17, 5, 0], [15, 8, 0], [12, 10, 0], [10, 10, 0]]) {
    poses = dragTo(current, [r1, r2], { kind: 'point', body: 'C', local: [10, 0, 0], target: t });
    current = withPoses(current, poses);
  }
  const tip = apply(poses.get('C'), [10, 0, 0]);
  const f1 = mateFrames(r1, poses), f2 = mateFrames(r2, poses);
  check('the tip gets there', dist(tip, [10, 10, 0]) < 1e-4, JSON.stringify(tip));
  check('the first joint stays put', dist(f1.b.o, [0, 0, 0]) < 1e-6);
  check('the elbow stays 10 from it', near(dist(f2.a.o, [0, 0, 0]), 10, 1e-6), `${dist(f2.a.o, [0, 0, 0])}`);
  check('the joints stay together', dist(f2.a.o, f2.b.o) < 1e-6);
  check('everything stays flat', Math.abs(tip[2]) < 1e-6 && Math.abs(f2.a.o[2]) < 1e-6);
  const fast = dragTo(bodies, [r1, r2], { kind: 'point', body: 'C', local: [10, 0, 0], target: [50, 0, 0] });
  check('pulled past its reach, it straightens toward the pointer', near(apply(fast.get('C'), [10, 0, 0])[0], 20, 1e-3), JSON.stringify(apply(fast.get('C'), [10, 0, 0])));
}

console.log('asking for too much');
{
  const a = mate('first', 'fastened', 'A', 'B', frame([10, 0, 0]), Z);
  const b = mate('second', 'fastened', 'C', 'B', frame([0, 40, 0]), Z);
  const r = solve([body('A', true), body('C', true, [100, 0, 0]), body('B', false, [10, 0, 0])], [a, b]);
  check('the mate that can’t hold is the one named', r.failed.length === 1 && r.failed[0].mate === 'second', JSON.stringify(r.failed));
  check('and it says which one it fights', /first/.test(r.failed[0].reason), r.failed[0].reason);
  check('the first still holds', nearV(apply(r.poses.get('B'), [0, 0, 0]), [10, 0, 0], 1e-6));
  check('and nothing’s left free', r.dof === 0, `${r.dof}`);
}
{
  const r = solve([body('A', true), body('B', true, [30, 0, 0])], [mate('both', 'fastened', 'A', 'B', Z, Z)]);
  check('two fixed parts apart say so', r.failed.length === 1 && /fixed/.test(r.failed[0].reason), JSON.stringify(r.failed));
  const ok = solve([body('A', true), body('B', true)], [mate('both', 'fastened', 'A', 'B', Z, Z)]);
  check('two fixed parts already together are fine', ok.failed.length === 0);
}
{
  const r = solve([body('A')], [mate('self', 'revolute', 'A', 'A', Z, Z)]);
  check('a mate on one part says so', r.failed.length === 1 && /same part/.test(r.failed[0].reason), JSON.stringify(r.failed));
}
{
  const r1 = mate('r', 'revolute', 'A', 'B', Z, Z);
  const s1 = mate('s', 'revolute', 'A', 'B', frame([0, 0, 0], [1, 0, 0], [0, 1, 0]), frame([0, 0, 0], [1, 0, 0], [0, 1, 0]));
  const r = solve([body('A', true), body('B')], [r1, s1]);
  check('two revolutes on crossing axes lock it rather than fail', r.failed.length === 0 && r.dof === 0, `${r.dof} ${JSON.stringify(r.failed)}`);
}
{
  const same = mate('again', 'revolute', 'A', 'B', frame([0, 0, 5]), frame([0, 0, 5]));
  const r = solve([body('A', true), body('B')], [mate('r', 'revolute', 'A', 'B', Z, Z), same]);
  check('a second revolute on the same axis changes nothing', r.failed.length === 0 && r.dof === 1, `${r.dof} ${JSON.stringify(r.failed)}`);
}
{
  const r = solve([body('A', true), body('B', false, [0, 0, 0])], [mate('p', 'parallel', 'A', 'B', Z, frame([0, 0, 0], [1, 0, 0], [0, 0, 1]))]);
  check('a parallel mate turns the part to suit', r.failed.length === 0 && r.residual < 1e-6, `${r.residual}`);
}

console.log('a part that stays where it is when the mates are already met');
{
  const m = mate('r', 'revolute', 'A', 'B', Z, Z);
  const q = axisAngle([0, 0, 1], 37);
  const r = solve([body('A', true), body('B', false, [0, 0, 0], q)], [m]);
  check('a swung part stays swung', sameTurn(r.poses.get('B').q, q), JSON.stringify(r.poses.get('B').q));
}

console.log('tangent mates, by the faces they are between');
{
  const plane = { surface: 'plane', radius: 0 };
  const cyl = (r) => ({ surface: 'cylinder', radius: r });
  const ball = (r) => ({ surface: 'sphere', radius: r });
  const up = frame([0, 0, 0], [0, 0, 1]);
  // A floor's top face, and a cylinder of radius 5 standing straight up, its axis through its connector.
  let r = solve([body('F', true), body('C', false, [3, 4, 20])], [mate('t', 'tangent', 'F', 'C', up, frame([0, 0, 0], [0, 0, 1]), { sa: plane, sb: cyl(5) })]);
  let pc = r.poses.get('C');
  const axis = rotate(pc.q, [0, 0, 1]);
  check('a cylinder standing up lies down level on a plane', r.failed.length === 0 && Math.abs(axis[2]) < 1e-6, JSON.stringify(axis));
  check('with its axis its radius above it', near(apply(pc, [0, 0, 0])[2], 5, 1e-6), JSON.stringify(apply(pc, [0, 0, 0])));
  check('it can still roll, slide and turn: 4 freedoms', r.dof === 4 && tangentFreedom(plane, cyl(5)) === 4, `${r.dof}`);
  r = solve([body('F', true), body('C', false, [3, 4, 20])], [mate('t', 'tangent', 'F', 'C', up, frame([0, 0, 0], [1, 0, 0]), { sa: plane, sb: cyl(5), flip: true })]);
  check('flipped, it goes under the plane', near(apply(r.poses.get('C'), [0, 0, 0])[2], -5, 1e-6), JSON.stringify(apply(r.poses.get('C'), [0, 0, 0])));
  // The same written the other way round: the cylinder first.
  r = solve([body('C', false, [3, 4, 20]), body('F', true)], [mate('t', 'tangent', 'C', 'F', frame([0, 0, 0], [1, 0, 0]), up, { sa: cyl(5), sb: plane })]);
  check('either connector can be the cylinder', r.failed.length === 0 && near(apply(r.poses.get('C'), [0, 0, 0])[2], 5, 1e-6));
  // Two cylinders: radii 5 and 3, axes along x and tilted, 20 apart.
  r = solve([body('A', true), body('B', false, [0, 20, 1], axisAngle([0, 0, 1], 30))], [mate('t', 'tangent', 'A', 'B', frame([0, 0, 0], [1, 0, 0]), frame([0, 0, 0], [1, 0, 0]), { sa: cyl(5), sb: cyl(3) })]);
  const pb = r.poses.get('B');
  const ab = rotate(pb.q, [1, 0, 0]);
  const o = apply(pb, [0, 0, 0]);
  check('two cylinders keep their axes parallel', r.failed.length === 0 && near(Math.abs(ab[0]), 1, 1e-6), JSON.stringify(ab));
  check('and their radii apart', near(Math.hypot(o[1], o[2]), 8, 1e-6), `${Math.hypot(o[1], o[2])}`);
  r = solve([body('A', true), body('B', false, [0, 20, 1], axisAngle([0, 0, 1], 30))], [mate('t', 'tangent', 'A', 'B', frame([0, 0, 0], [1, 0, 0]), frame([0, 0, 0], [1, 0, 0]), { sa: cyl(5), sb: cyl(3), flip: true })]);
  const oi = apply(r.poses.get('B'), [0, 0, 0]);
  check('flipped, one rolls inside the other', near(Math.hypot(oi[1], oi[2]), 2, 1e-6), `${Math.hypot(oi[1], oi[2])}`);
  r = solve([body('F', true), body('S', false, [1, 2, 30])], [mate('t', 'tangent', 'F', 'S', up, frame([0, 0, 0]), { sa: plane, sb: ball(4) })]);
  check('a ball rests on a plane', near(apply(r.poses.get('S'), [0, 0, 0])[2], 4, 1e-6) && r.dof === 5, `${apply(r.poses.get('S'), [0, 0, 0])} ${r.dof}`);
  r = solve([body('A', true), body('S', false, [10, 10, 10])], [mate('t', 'tangent', 'A', 'S', frame([0, 0, 0]), frame([0, 0, 0]), { sa: ball(4), sb: ball(6) })]);
  check('two balls touch', near(dist(apply(r.poses.get('S'), [0, 0, 0]), [0, 0, 0]), 10, 1e-6));
  r = solve([body('F', true), body('P', false, [1, 2, 30], axisAngle([1, 0, 0], 40))], [mate('t', 'tangent', 'F', 'P', up, frame([0, 0, 0], [0, 0, 1]), { sa: plane, sb: plane })]);
  const pp = r.poses.get('P');
  check('two flat faces go face to face', near(apply(pp, [0, 0, 0])[2], 0, 1e-6) && near(rotate(pp.q, [0, 0, 1])[2], -1, 1e-6) && r.dof === 3, `${rotate(pp.q, [0, 0, 1])} ${r.dof}`);
}

console.log('width mates');
{
  // A slot's middle plane, x = 10, facing x, and a tab's middle somewhere else.
  const r = solve([body('S', true), body('T', false, [3, 4, 5])], [mate('w', 'width', 'S', 'T', frame([10, 0, 0], [1, 0, 0]), frame([0, 0, 0], [0, 0, 1]))]);
  const o = apply(r.poses.get('T'), [0, 0, 0]);
  check('the tab’s middle goes onto the slot’s', near(o[0], 10, 1e-6) && r.dof === 5, `${o} ${r.dof}`);
  check('and nothing else moves', near(o[1], 4, 1e-6) && near(o[2], 5, 1e-6), `${o}`);
}

console.log('patterns and exploded views');
{
  const { derivedCopies, explodeShifts, compose, inverse } = await import('../src/assembly/extras.ts');
  const inst = (id, p, q = [0, 0, 0, 1]) => ({ id, tab: 't1', body: 'f1', number: 1, name: null, pose: { p, q }, fixed: false, hidden: false });
  const data = { format: 'schmishape-assembly', version: 1, instances: [inst('A', [10, 0, 0]), inst('B', [0, 0, 5])], mates: [], next: 9,
    patterns: [
      { id: 'p1', name: 'Row', of: ['A'], type: 'linear', axis: 'y', spacing: 15, degrees: 0, count: 3, suppressed: false },
      { id: 'p2', name: 'Ring', of: ['A'], type: 'circular', axis: 'z', spacing: 0, degrees: 90, count: 4, suppressed: false },
      { id: 'p3', name: 'Off', of: ['B'], type: 'linear', axis: 'x', spacing: 5, degrees: 0, count: 5, suppressed: true },
    ] };
  const c = derivedCopies(data, () => undefined);
  const row = c.filter((x) => x.from === 'p1');
  check('a linear pattern of 3 makes 2 copies, spaced along its direction', row.length === 2 && nearV(row[0].pose.p, [10, 15, 0]) && nearV(row[1].pose.p, [10, 30, 0]), JSON.stringify(row.map((x) => x.pose.p)));
  const ring = c.filter((x) => x.from === 'p2');
  check('a circular one turns them about its axis', ring.length === 3 && nearV(ring[0].pose.p, [0, 10, 0]) && nearV(ring[1].pose.p, [-10, 0, 0]) && nearV(ring[2].pose.p, [0, -10, 0]), JSON.stringify(ring.map((x) => x.pose.p)));
  check('turned as well as moved', nearV(rotate(ring[0].pose.q, [1, 0, 0]), [0, 1, 0]));
  check('a suppressed one makes none', !c.some((x) => x.from === 'p3'));
  // An axis along a connector follows its part.
  const along = { ...data, patterns: [{ id: 'p4', name: 'Along', of: ['A'], type: 'linear', axis: { instance: 'B', connector: { kind: 'face', ref: 'x', how: 'centroid', frame: frame([0, 0, 0], [0, 0, 1]) } }, spacing: 10, degrees: 0, count: 2, suppressed: false }] };
  along.instances[1].pose = { p: [0, 0, 5], q: axisAngle([0, 1, 0], 90) };
  const a = derivedCopies(along, () => undefined);
  check('along a connector, it goes the way the connector’s part points it', a.length === 1 && nearV(a[0].pose.p, [20, 0, 0]), JSON.stringify(a.map((x) => x.pose.p)));
  const pose = { p: [1, 2, 3], q: axisAngle([Math.SQRT1_2, Math.SQRT1_2, 0], 33) };
  const back = compose(pose, inverse(pose));
  check('a pose and its inverse cancel', nearV(back.p, [0, 0, 0]) && sameTurn(back.q, [0, 0, 0, 1]));
  const ex = { ...data, explodes: [{ id: 'x1', name: 'E', steps: [{ instances: ['A'], shift: [0, 0, 10] }, { instances: ['A', 'B'], shift: [5, 0, 0] }] }] };
  check('an exploded view half way has done its first step', nearV(explodeShifts(ex, 'x1', 0.5).get('A'), [0, 0, 10]) && !explodeShifts(ex, 'x1', 0.5).has('B'));
  check('and all the way, both', nearV(explodeShifts(ex, 'x1', 1).get('A'), [5, 0, 10]) && nearV(explodeShifts(ex, 'x1', 1).get('B'), [5, 0, 0]));
  check('three quarters of the way, half the second', nearV(explodeShifts(ex, 'x1', 0.75).get('B'), [2.5, 0, 0]));
}

console.log('speed');
{
  // Ten parts in a chain, about what one drag has to solve in a real assembly.
  const bodies = [body('P0', true)];
  const mates = [];
  for (let i = 1; i < 10; i++) {
    bodies.push(body(`P${i}`, false, [i * 10, 0, 0]));
    mates.push(mate(`r${i}`, 'revolute', `P${i - 1}`, `P${i}`, frame([10, 0, 0]), Z));
  }
  const placed = solve(bodies, mates);
  check('nine revolutes in a chain have nine freedoms', placed.dof === 9 && placed.failed.length === 0, `${placed.dof}`);
  const current = withPoses(bodies, placed.poses);
  const t0 = performance.now();
  let n = 0;
  let last = current;
  for (let a = 0; a < 30; a++) {
    const p = dragTo(last, mates, { kind: 'point', body: 'P9', local: [0, 0, 0], target: [90 - a, a, 0] });
    last = withPoses(last, p);
    n++;
  }
  const ms = (performance.now() - t0) / n;
  check('dragging it is quick enough for a pointer', ms < 40, `${ms.toFixed(1)} ms per move`);
  const res = solve(last, mates);
  check('and it’s still together', res.residual < 1e-5, `${res.residual}`);
}
void IDENTITY;

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);

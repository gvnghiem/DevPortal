// @playcanvas — a tiny solar system: parent/child entities do the orbit maths for you
const app = new pc.Application(canvas, {});
app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
app.setCanvasResolution(pc.RESOLUTION_AUTO);
window.addEventListener("resize", () => app.resizeCanvas());
app.scene.ambientLight = new pc.Color(0.12, 0.12, 0.16);

function mk(name, color, size, emissive) {
  const m = new pc.StandardMaterial();
  m.diffuse = emissive ? new pc.Color(0, 0, 0) : color;
  if (emissive) m.emissive = color;
  m.update();
  const e = new pc.Entity(name);
  e.addComponent("render", { type: "sphere", material: m });
  e.setLocalScale(size, size, size);
  return e;
}

const cam = new pc.Entity("cam");
cam.addComponent("camera", { clearColor: new pc.Color(0.01, 0.01, 0.03), farClip: 100 });
cam.setPosition(0, 9, 12);
cam.lookAt(0, 0, 0);
app.root.addChild(cam);

const sun = mk("sun", new pc.Color(1, 0.8, 0.2), 2, true);
sun.addComponent("light", { type: "omni", color: new pc.Color(1, 0.95, 0.8), intensity: 3, range: 40 });
app.root.addChild(sun);

const planets = [
  { name: "mercury", c: [0.7, 0.7, 0.7], r: 0.3, d: 3,   speed: 90 },
  { name: "earth",   c: [0.2, 0.5, 1],   r: 0.5, d: 5,   speed: 50, moon: true },
  { name: "mars",    c: [0.9, 0.35, 0.2], r: 0.4, d: 7,   speed: 35 },
  { name: "jupiter", c: [0.9, 0.7, 0.5], r: 1.1, d: 10,  speed: 18 },
];
const pivots = planets.map(p => {
  const pivot = new pc.Entity(p.name + "-pivot");        // rotating the pivot = orbiting its child
  const body = mk(p.name, new pc.Color(...p.c), p.r);
  body.setLocalPosition(p.d, 0, 0);
  pivot.addChild(body);
  if (p.moon) {
    const moonPivot = new pc.Entity("moon-pivot");
    const moon = mk("moon", new pc.Color(0.8, 0.8, 0.8), 0.15);
    moon.setLocalPosition(1.1, 0, 0);
    moonPivot.addChild(moon);
    body.addChild(moonPivot);
    pivot.moonPivot = moonPivot;
  }
  app.root.addChild(pivot);
  return { pivot, speed: p.speed };
});

app.on("update", dt => {
  pivots.forEach(o => {
    o.pivot.rotate(0, o.speed * dt, 0);
    if (o.pivot.moonPivot) o.pivot.moonPivot.rotate(0, 200 * dt, 0);
  });
});
app.start();
console.log("planets:", planets.map(p => p.name).join(", "));

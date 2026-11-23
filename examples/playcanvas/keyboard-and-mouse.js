// @playcanvas — input: move the cube with WASD / arrow keys, click the canvas to spawn spheres
const app = new pc.Application(canvas, { keyboard: new pc.Keyboard(window), mouse: new pc.Mouse(canvas) });
app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
app.setCanvasResolution(pc.RESOLUTION_AUTO);
window.addEventListener("resize", () => app.resizeCanvas());
app.scene.ambientLight = new pc.Color(0.3, 0.3, 0.35);

const cam = new pc.Entity("cam");
cam.addComponent("camera", { clearColor: new pc.Color(0.08, 0.09, 0.13) });
cam.setPosition(0, 10, 8);
cam.lookAt(0, 0, 0);
app.root.addChild(cam);

const light = new pc.Entity("light");
light.addComponent("light", { type: "directional", intensity: 1.2 });
light.setEulerAngles(50, 20, 0);
app.root.addChild(light);

function material(r, g, b) { const m = new pc.StandardMaterial(); m.diffuse = new pc.Color(r, g, b); m.update(); return m; }

const floor = new pc.Entity("floor");
floor.addComponent("render", { type: "plane", material: material(0.18, 0.2, 0.26) });
floor.setLocalScale(14, 1, 14);
app.root.addChild(floor);

const player = new pc.Entity("player");
player.addComponent("render", { type: "box", material: material(1, 0.55, 0.15) });
player.setPosition(0, 0.5, 0);
app.root.addChild(player);

const balls = [];
app.mouse.on(pc.EVENT_MOUSEDOWN, e => {
  // turn the click into a point on the floor (y = 0) by casting a ray from the camera
  const near = cam.camera.screenToWorld(e.x, e.y, cam.camera.nearClip);
  const far = cam.camera.screenToWorld(e.x, e.y, cam.camera.farClip);
  const dir = far.clone().sub(near).normalize();
  if (Math.abs(dir.y) < 1e-4) return;
  const k = -near.y / dir.y;
  const p = near.clone().add(dir.mulScalar(k));
  const b = new pc.Entity("ball");
  b.addComponent("render", { type: "sphere", material: material(Math.random(), Math.random(), Math.random()) });
  b.setLocalScale(0.6, 0.6, 0.6);
  b.setPosition(p.x, 3, p.z);
  b.vy = 0;
  app.root.addChild(b);
  balls.push(b);
  console.log("spawned ball #" + balls.length + " at", p.x.toFixed(1), p.z.toFixed(1));
});

const speed = 6;
app.on("update", dt => {
  const k = app.keyboard;
  let x = 0, z = 0;
  if (k.isPressed(pc.KEY_A) || k.isPressed(pc.KEY_LEFT))  x -= 1;
  if (k.isPressed(pc.KEY_D) || k.isPressed(pc.KEY_RIGHT)) x += 1;
  if (k.isPressed(pc.KEY_W) || k.isPressed(pc.KEY_UP))    z -= 1;
  if (k.isPressed(pc.KEY_S) || k.isPressed(pc.KEY_DOWN))  z += 1;
  const p = player.getPosition();
  player.setPosition(p.x + x * speed * dt, 0.5, p.z + z * speed * dt);

  balls.forEach(b => {             // hand-rolled gravity + bounce (no physics engine needed)
    b.vy -= 9.8 * dt;
    const q = b.getPosition();
    let y = q.y + b.vy * dt;
    if (y < 0.3) { y = 0.3; b.vy = -b.vy * 0.7; }
    b.setPosition(q.x, y, q.z);
  });
});
app.start();
canvas.focus && canvas.setAttribute("tabindex", "0");
console.log("click the preview once, then use WASD / arrows; click to drop balls");

// @playcanvas — PlayCanvas 3D engine (global `pc`, `canvas` already on the page)
const app = new pc.Application(canvas, {});
app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
app.setCanvasResolution(pc.RESOLUTION_AUTO);
window.addEventListener("resize", () => app.resizeCanvas());

// camera
const camera = new pc.Entity("camera");
camera.addComponent("camera", { clearColor: new pc.Color(0.05, 0.06, 0.1) });
camera.setPosition(0, 1.5, 5);
camera.lookAt(0, 0, 0);
app.root.addChild(camera);

// light
const sun = new pc.Entity("sun");
sun.addComponent("light", { type: "directional", intensity: 1.4 });
sun.setEulerAngles(45, 30, 0);
app.root.addChild(sun);
app.scene.ambientLight = new pc.Color(0.25, 0.25, 0.3);

// a cube with its own material
const mat = new pc.StandardMaterial();
mat.diffuse = new pc.Color(0.2, 0.6, 1);
mat.update();
const cube = new pc.Entity("cube");
cube.addComponent("render", { type: "box", material: mat });
app.root.addChild(cube);

// ground
const floorMat = new pc.StandardMaterial();
floorMat.diffuse = new pc.Color(0.15, 0.15, 0.2);
floorMat.update();
const floor = new pc.Entity("floor");
floor.addComponent("render", { type: "plane", material: floorMat });
floor.setLocalScale(8, 1, 8);
floor.setPosition(0, -1, 0);
app.root.addChild(floor);

let t = 0;
app.on("update", dt => {
  t += dt;
  cube.rotate(20 * dt, 35 * dt, 10 * dt);
  cube.setPosition(0, Math.sin(t * 2) * 0.4, 0);
});

app.start();
console.log("PlayCanvas engine v" + pc.version + " is running");

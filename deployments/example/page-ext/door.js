// A door sensor from a tap (docs/peripheral-pages.md): a phone taped beside a door, a strip of paper on the door
// that touches the pad on the screen while the door is shut. The page loads this file after its kit with
// --page-ext deployments/example/page-ext; the model then has <page name>.door.
const el = document.body.appendChild(Object.assign(document.createElement("div"), { className: "sc-pad" }));
let opened = 0;
spinecord.device({
  id: "door",
  kind: "contact",
  description: "A contact pad on this screen: closed is true while something touches it.",
  channels: [
    { name: "closed", type: "boolean", pushed: true, description: "true while the pad is touched." },
    {
      name: "opened_count",
      type: "number",
      pushed: true,
      description: "Times the pad was released since the page joined.",
    },
  ],
  commands: [],
});
spinecord.push("door", { closed: false, opened_count: 0 });
el.addEventListener("pointerdown", () => spinecord.push("door", { closed: true }));
el.addEventListener("pointerup", () => spinecord.push("door", { closed: false, opened_count: ++opened }));

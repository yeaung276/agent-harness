const NAV = [
  { id: "appx-preview", title: "Architecture", href: "index.html" },
  { id: "commands", title: "Commands", href: "commands.html" },
  { id: "schema", title: "Schema", href: "schema.html" },
  { id: "cache-keys", title: "Cache keys", href: "cache-keys.html" },
];

const STATUS_LABEL = { draft: "Draft", soon: "Soon", live: "Current" };

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "text") node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

function badge(status) {
  return el("span", { class: `badge ${status}`, text: STATUS_LABEL[status] });
}

function pageToc() {
  const sections = document.querySelectorAll("main section[id] > h2");
  if (!sections.length) return null;
  return el(
    "ul",
    { class: "toc" },
    [...sections].map((h2) =>
      el("li", {}, [el("a", { href: `#${h2.parentElement.id}`, text: h2.textContent })]),
    ),
  );
}

function caret() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M4 6l4 4 4-4");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

function navItem(item, root, current) {
  const label = [el("span", { text: item.title })];
  if (item.status && item.status !== "live") label.push(badge(item.status));
  const li = el("li", { class: "nav-item" });

  if (item.children) {
    const expanded = item.children.some((child) => child.id === current);
    const row = el("button", { class: "nav-link nav-group", type: "button" }, [...label, el("span", { class: "nav-caret" }, [caret()])]);
    row.setAttribute("aria-expanded", String(expanded));
    if (!expanded) li.classList.add("is-collapsed");
    row.addEventListener("click", () => {
      const collapsed = li.classList.toggle("is-collapsed");
      row.setAttribute("aria-expanded", String(!collapsed));
    });
    li.append(row, el("ul", { class: "children" }, item.children.map((child) => navItem(child, root, current))));
    return li;
  }

  if (!item.href) {
    li.append(el("span", { class: "nav-link is-soon" }, label));
    return li;
  }

  const active = item.id === current;
  li.append(el("a", { class: `nav-link${active ? " is-active" : ""}`, href: root + item.href }, label));

  const toc = active && pageToc();
  if (toc) li.append(toc);
  return li;
}

function renderNav(root, current) {
  const sidebar = document.querySelector(".sidebar");
  const head = el("div", { class: "sidebar-head" }, [
    el("a", { class: "brand", href: `${root}index.html` }, [
      el("strong", { text: "Code-Harness" }),
      el("span", { text: "Architecture" }),
    ]),
    el("button", { class: "menu-toggle", type: "button", text: "Menu" }),
  ]);
  const themeToggle = el("button", { class: "theme-toggle", type: "button" });
  const nav = el("nav", { class: "nav" }, [el("ul", {}, NAV.map((item) => navItem(item, root, current)))]);
  sidebar.replaceChildren(head, nav, themeToggle);

  head.querySelector(".menu-toggle").addEventListener("click", () => sidebar.classList.toggle("is-open"));
  setupTheme(themeToggle);
}

function readTheme() {
  try {
    return localStorage.getItem("promptx-docs-theme");
  } catch {
    return null;
  }
}

function writeTheme(theme) {
  try {
    localStorage.setItem("promptx-docs-theme", theme);
  } catch {}
}

function setupTheme(button) {
  const html = document.documentElement;
  const systemDark = () => matchMedia("(prefers-color-scheme: dark)").matches;
  const isDark = () => (html.dataset.theme ? html.dataset.theme === "dark" : systemDark());
  const label = () => (button.textContent = isDark() ? "Light theme" : "Dark theme");

  const saved = readTheme();
  if (saved) html.dataset.theme = saved;
  label();

  button.addEventListener("click", () => {
    html.dataset.theme = isDark() ? "light" : "dark";
    writeTheme(html.dataset.theme);
    label();
  });
}

renderNav(document.body.dataset.root || "", document.body.dataset.page);

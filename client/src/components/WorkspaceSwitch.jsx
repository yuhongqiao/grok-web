export default function WorkspaceSwitch({ active }) {
  const destination = (name) => {
    const saved = sessionStorage.getItem(`${name}-web-location`);
    return saved?.startsWith(`/${name}`) ? saved : `/${name}`;
  };
  return (
    <nav className="workspace-switch" aria-label="切换工作台">
      {["grok", "codex"].map((name) => (
        <a
          key={name}
          href={destination(name)}
          aria-current={active === name ? "page" : undefined}
          data-testid={`switch-${name}`}
          onClick={(event) => {
            if (active === name) { event.preventDefault(); return; }
            sessionStorage.setItem(`${active}-web-location`, `/${active}${window.location.hash}`);
          }}
        >{name === "grok" ? "Grok" : "Codex"}</a>
      ))}
    </nav>
  );
}

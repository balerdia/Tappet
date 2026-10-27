import { NavLink, Outlet } from "react-router";
import { AccountButton } from "../auth";

const NAV = [
  { to: "/", label: "Home", end: true },
  { to: "/organise", label: "Organise" },
  { to: "/automate", label: "Automate" },
  { to: "/connections", label: "Connections" },
  { to: "/activity", label: "Activity" },
];

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-3 py-2 text-sm transition-colors ${
    isActive ? "bg-accent-soft text-accent font-medium" : "text-muted hover:text-ink"
  }`;

export function Layout() {
  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2 px-4 py-3">
          <span className="mr-4 font-semibold tracking-tight">Tappet</span>
          <nav className="flex flex-1 flex-wrap gap-1">
            {NAV.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end} className={linkClass}>
                {item.label}
              </NavLink>
            ))}
          </nav>
          <NavLink to="/settings" className={linkClass}>
            Settings
          </NavLink>
          <AccountButton />
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}

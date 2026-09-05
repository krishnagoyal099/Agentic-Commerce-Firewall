// apps/web/src/components/layout/Nav.tsx
import { NavLink } from 'react-router-dom';

const LINKS = [
  { to: '/', label: 'Overview' },
  { to: '/firewall', label: 'Firewall' },
  { to: '/protocol', label: 'Protocol' },
  { to: '/growth', label: 'Growth' },
  { to: '/attacks', label: 'Attack Lab' },
  { to: '/payments', label: 'Payments' },
  { to: '/merchant', label: 'Merchant' },
  { to: '/audit', label: 'Audit' },
] as const;

export function Nav() {
  return (
    <nav className="flex flex-wrap items-center gap-1.5">
      {LINKS.map((link, i) => (
        <NavLink
          key={link.to}
          to={link.to}
          end={link.to === '/'}
          className={({ isActive }) =>
            `group inline-flex items-center gap-2 rounded-full px-3.5 py-2 text-[13px] font-semibold transition-all ${
              isActive
                ? 'bg-brand-500 text-white shadow-lift'
                : 'bg-white/70 text-ink-soft hover:bg-white hover:text-ink'
            }`
          }
        >
          {({ isActive }) => (
            <>
              <span
                className={`grid h-5 w-5 place-items-center rounded-full font-mono text-[10px] font-bold ${
                  isActive ? 'bg-white/20 text-white' : 'bg-canvas-soft text-ink-faint'
                }`}
              >
                {String(i + 1).padStart(2, '0')}
              </span>
              {link.label}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

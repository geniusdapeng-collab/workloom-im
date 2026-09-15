import type { SVGProps } from "react";
import type { IconName } from "./navigation";

const PATHS: Readonly<Record<IconName, readonly string[]>> = {
  home: ["M3 20h18", "M5 20V9l7-5 7 5v11", "M9 20v-6h6v6"],
  tasks: ["M5 5h14v14H5z", "M8 9h8", "M8 13h6"],
  report: ["M5 20V10", "M12 20V4", "M19 20v-7"],
  service: ["M4 17v-5a8 8 0 0116 0v5", "M3 17h18v3H3"],
  approval: ["M4 12l5 5L20 6"],
  ledger: ["M5 3h14v18H5z", "M8 7h8", "M8 11h8", "M8 15h5"],
  rules: ["M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6z"],
  exam: ["M12 15a5 5 0 100-10 5 5 0 000 10z", "M8.5 13.5L7 22l5-3 5 3-1.5-8.5"],
  memory: ["M12 3a7 7 0 017 7c0 3-2 4-2 6H7c0-2-2-3-2-6a7 7 0 017-7z", "M9 20h6"],
  night: ["M21 12.8A9 9 0 1111.2 3 7 7 0 0021 12.8z"],
  model: ["M4 6h16", "M7 12h10", "M10 18h4", "M7 4v4", "M15 10v4", "M12 16v4"],
  skills: ["M10 4h4v4h4v4h-4v4h-4v-4H6V8h4z", "M4 20h16"],
  team: ["M16 19c0-2.8-1.8-5-4-5s-4 2.2-4 5", "M12 11a3 3 0 100-6 3 3 0 000 6z"],
  workspace: ["M4 20V8l8-5 8 5v12", "M4 20h16", "M9 12h6"],
  inbox: ["M4 5h16v14H4z", "M8 9h8", "M8 13h5"],
  account: ["M12 12a4 4 0 100-8 4 4 0 000 8z", "M4 21a8 8 0 0116 0"],
  partner: ["M8 12h8", "M12 8v8", "M5 5h14v14H5z"],
  more: ["M5 12h.01", "M12 12h.01", "M19 12h.01"],
  executive: ["M3 18l2-9 5 4 2-8 2 8 5-4 2 9z", "M5 21h14"],
  customize: ["M12 8.5a3.5 3.5 0 100 7 3.5 3.5 0 000-7z", "M21 13.4v-2.8l-2.3-.5-.6-1.5 1.3-2-2-2-2 1.3-1.5-.6L13.5 3h-3l-.4 2.3-1.5.6-2-1.3-2 2 1.3 2-.6 1.5-2.3.5v2.8l2.3.5.6 1.5-1.3 2 2 2 2-1.3 1.5.6.4 2.3h3l.4-2.3 1.5-.6 2 1.3 2-2-1.3-2 .6-1.5z"],
  configuration: ["M4 6h16", "M7 12h10", "M10 18h4", "M7 4v4", "M15 10v4", "M12 16v4"],
  assembly: ["M4 20V8l8-5 8 5v12", "M4 20h16", "M12 20v-7"],
  agents: ["M16 19c0-2.8-1.8-5-4-5s-4 2.2-4 5", "M12 11a3 3 0 100-6 3 3 0 000 6z", "M19 19c0-2-1-3.6-2.5-4.2", "M5 19c0-2 1-3.6 2.5-4.2"],
  developer: ["M8 9l-3 3 3 3", "M16 9l3 3-3 3", "M14 5l-4 14"],
  menu: ["M4 7h16", "M4 12h16", "M4 17h16"],
  close: ["M5 5l14 14", "M19 5L5 19"],
  reset: ["M4 11a8 8 0 101.8-5", "M4 4v7h7"],
  search: ["M11 18a7 7 0 100-14 7 7 0 000 14z", "M16 16l5 5"],
  notice: ["M6 17h12l-1.5-2V10a4.5 4.5 0 00-9 0v5z", "M10 20h4"],
  chevron: ["M9 5l7 7-7 7"],
  chat: ["M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"],
  ticket: ["M6 3h9l3 3v15H6z", "M15 3v4h4", "M9 12h6", "M9 16h6"],
  star: ["M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8-4.2-4.1 5.9-.9z"],
  history: ["M4 12a8 8 0 108-8 8.4 8.4 0 00-6 2.5L4 9", "M4 4v5h5", "M12 8v5l3 2"],
  warning: ["M12 3L2.8 20h18.4z", "M12 9v4", "M12 17h.01"],
  check: ["M4 12l5 5L20 6"],
  error: ["M5 5l14 14", "M19 5L5 19"],
  edit: ["M4 20h4l11-11-4-4L4 16z", "M13.5 6.5l4 4"],
  lock: ["M6 10h12v11H6z", "M8.5 10V7a3.5 3.5 0 017 0v3"],
  pin: ["M8 4h8l-1 5 3 3H6l3-3z", "M12 12v9"],
  book: ["M4 19.5A2.5 2.5 0 016.5 17H20", "M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"],
  phone: ["M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6 19.8 19.8 0 01-3.1-8.7A2 2 0 014.1 2h3a2 2 0 012 1.7c.1 1 .4 1.9.7 2.8a2 2 0 01-.5 2.1L8.1 9.9a16 16 0 006 6l1.3-1.3a2 2 0 012.1-.5c.9.3 1.9.6 2.8.7a2 2 0 011.7 2.1z"],
  play: ["M8 5l11 7-11 7z"],
  copy: ["M9 9h11v11H9z", "M4 15V4h11"],
  like: ["M7 10v11H3V10z", "M7 19h10.5a2 2 0 002-1.7l1.3-6A2 2 0 0018.9 9H14l.7-3.5A2.9 2.9 0 0012 2l-1 5-4 4z"],
  dislike: ["M7 14V3H3v11z", "M7 5h10.5a2 2 0 011.9 2.4l1.3 6A2 2 0 0118.9 16H14l.7 3.5A2.9 2.9 0 0112 23l-1-5-4-4z"],
  gift: ["M3 9h18v12H3z", "M2 5h20v4H2z", "M12 5v16", "M12 5c-1-4-6-3-4 0M12 5c1-4 6-3 4 0"],
  cart: ["M3 4h2l2 11h10l3-7H6", "M9 20h.01", "M17 20h.01"],
  radar: ["M12 12l6-6", "M12 4a8 8 0 108 8", "M12 8a4 4 0 104 4", "M12 12h.01"],
  send: ["M3 11.5L21 3l-8.5 18-2.3-7.2z", "M10.2 13.8L21 3"],
  package: ["M3 7l9-4 9 4v10l-9 4-9-4z", "M3 7l9 4 9-4", "M12 11v10"],
  experiment: ["M9 3h6", "M10 3v6l-5 9a2 2 0 001.8 3h10.4a2 2 0 001.8-3l-5-9V3", "M7.5 16h9"],
  lightning: ["M13 2L4 14h7l-1 8 9-12h-7z"],
  medal: ["M8 3l4 7 4-7", "M12 21a5 5 0 100-10 5 5 0 000 10z", "M12 14v4"],
  rocket: ["M14 4c3-2 5-1 6-1 0 1 1 3-1 6-3l-6 6-4-2z", "M8 12l-3 1-2 4 4-1", "M12 16l-1 4-4 2 1-5", "M5 19l-2 2"],
  puzzle: ["M4 4h6a2 2 0 104 0h6v6a2 2 0 110 4v6h-6a2 2 0 10-4 0H4v-6a2 2 0 100-4z"],
  folder: ["M3 6h7l2 2h9v11H3z"],
  palette: ["M12 3a9 9 0 100 18h1.5a2 2 0 000-4H11a2 2 0 010-4h1a5 5 0 000-10z", "M7 10h.01", "M9 6h.01", "M14 6h.01", "M17 10h.01"],
  celebrate: ["M4 20l4-12 8 8z", "M9 11l3-3", "M14 4h.01", "M18 7h.01", "M19 12h.01", "M11 4h.01"],
  question: ["M9.5 9a2.8 2.8 0 115 2c-1.5 1-2.5 1.6-2.5 3", "M12 18h.01", "M12 22a10 10 0 100-20 10 10 0 000 20z"],
  brake: ["M8 2h8l6 6v8l-6 6H8l-6-6V8z", "M8 8l8 8", "M16 8l-8 8"],
  circle: ["M12 21a9 9 0 100-18 9 9 0 000 18z"],
  document: ["M6 3h9l3 3v15H6z", "M15 3v4h4", "M9 11h6", "M9 15h6"],
};

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  label?: string;
  size?: number;
}

export function Icon({ name, label, size = 20, fill = "none", stroke = "currentColor", ...props }: IconProps) {
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke={stroke}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {PATHS[name].map((path) => <path d={path} key={path} />)}
    </svg>
  );
}

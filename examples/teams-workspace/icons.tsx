import React from "react";
const paths: Record<string, React.ReactNode> = {
  bell: <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />,
  chat: (
    <>
      <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 0 1 19 0Z" />
      <path d="M7 9h9M7 13h6" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  folder: <path d="M3 6h7l2 3h9v11H3z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  arrow: <path d="m9 5 7 7-7 7" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  send: (
    <>
      <path d="m4 4 17 8-17 8 3-8-3-8ZM7 12h14" />
    </>
  ),
  attach: <path d="m8 13 7-7a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L12 3" />,
  check: <path d="m5 12 4 4L19 6" />,
  star: <path d="m12 3 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z" />,
  users: (
    <>
      <circle cx="9" cy="7" r="3" />
      <path d="M3 21v-3a6 6 0 0 1 12 0v3M17 4a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 5v2" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h16M4 17h16" />
      <circle cx="9" cy="7" r="3" />
      <circle cx="15" cy="17" r="3" />
    </>
  ),
  play: <path d="m8 4 12 8-12 8z" />,
  file: (
    <>
      <path d="M5 3h9l5 5v13H5zM14 3v6h5M8 13h8M8 17h5" />
    </>
  ),
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  heart: <path d="M12 20 3 11a5 5 0 0 1 9-5 5 5 0 0 1 9 5z" />,
};
export function Icon({ name }: { name: string }) {
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.chat}
    </svg>
  );
}

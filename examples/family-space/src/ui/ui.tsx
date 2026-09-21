import React, { useEffect, useState } from "react";
import { mediaObjectUrl, safeUrl, type Member } from "../data";
import {
  SquaresFourIcon,
  UsersThreeIcon,
  UserCircleIcon,
  CalendarDotsIcon,
  ChatCircleDotsIcon,
  ArticleIcon,
  CheckCircleIcon,
  CameraIcon,
  VideoCameraIcon,
  PlusIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  PlayIcon,
  ListIcon,
  BellIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";

const icons: Record<string, PhosphorIcon> = {
  apps: SquaresFourIcon,
  home: UsersThreeIcon,
  user: UserCircleIcon,
  calendar: CalendarDotsIcon,
  chat: ChatCircleDotsIcon,
  article: ArticleIcon,
  check: CheckCircleIcon,
  camera: CameraIcon,
  video: VideoCameraIcon,
  plus: PlusIcon,
  back: ArrowLeftIcon,
  right: ArrowRightIcon,
  play: PlayIcon,
  menu: ListIcon,
  bell: BellIcon,
};
export function Icon({
  name,
  active = false,
}: {
  name: string;
  active?: boolean;
}) {
  const Glyph = icons[name];
  if (!Glyph) return null;
  return (
    <Glyph
      className="icon"
      weight={active ? "fill" : "regular"}
      aria-hidden="true"
    />
  );
}
export function Avatar({
  member,
  large = false,
}: {
  member?: Member;
  large?: boolean;
}) {
  return member?.avatar ? (
    <img
      className={`avatar ${large ? "large" : ""}`}
      src={member.avatar}
      alt=""
    />
  ) : (
    <span className={`avatar initials ${large ? "large" : ""}`}>
      {member?.name?.[0] ?? "K"}
    </span>
  );
}
export function ErrorNotice({ message }: { message: string }) {
  return message ? (
    <div className="error-notice" role="alert">
      {message}
    </div>
  ) : null;
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <Icon name="home" />
      <h2>{title}</h2>
      {children && <p>{children}</p>}
    </div>
  );
}
export function Media({
  path,
  url,
  kind,
  alt,
  poster,
}: {
  path?: string;
  url?: string;
  kind: string;
  alt: string;
  poster?: string;
}) {
  const [src, setSrc] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true,
      object = "";
    setSrc("");
    setError("");
    if (path)
      void mediaObjectUrl(path, kind)
        .then((value) => {
          object = value;
          if (live) setSrc(value);
          else URL.revokeObjectURL(value);
        })
        .catch(() => {
          if (live)
            setError(
              "This attachment could not be loaded. Reopen the post to retry.",
            );
        });
    else setSrc(url ? safeUrl(url) : "");
    return () => {
      live = false;
      if (object) URL.revokeObjectURL(object);
    };
  }, [path, url, kind]);
  if (error) return <p className="media-error">{error}</p>;
  if (!src)
    return (
      <div className="media-loading" role="status">
        Loading attachment…
      </div>
    );
  if (kind === "video")
    return (
      <video
        src={src}
        controls
        preload="metadata"
        poster={poster}
        aria-label={alt}
      />
    );
  if (kind === "audio")
    return <audio src={src} controls preload="metadata" aria-label={alt} />;
  return <img src={src} alt={alt} loading="lazy" />;
}
export function when(time: number | string) {
  return new Date(time).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
export function clock(time: number | string) {
  return new Date(time).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}
export const navigate = (to: string) => {
  location.hash = to;
  window.scrollTo({ top: 0 });
};

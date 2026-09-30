import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { avatarUrl, hashColor, initials } from "../util";

interface Props {
  name: string;
  email: string;
  size: number;
  ring?: string;
  fill?: string;
}

export function Avatar({ name, email, size, ring, fill }: Props) {
  const enabled = useStore((s) => s.settings.avatars);
  const repo = useStore((s) => s.active);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setUrl(null);
    if (enabled && email) avatarUrl(email, repo ? () => api.githubAvatar(repo, email) : undefined).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [email, enabled]);

  const style = {
    width: size,
    height: size,
    fontSize: Math.round(size * 0.38),
    background: fill ?? hashColor(name),
    boxShadow: ring ? `0 0 0 2px ${ring}` : undefined,
  };
  return (
    <span className="avatar" style={style} title={`${name} <${email}>`}>
      {url ? <img src={url} alt="" draggable={false} /> : initials(name)}
    </span>
  );
}

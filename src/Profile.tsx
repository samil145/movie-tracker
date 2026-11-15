import { useState, type FormEvent } from "react";
import { auth, formatMinutes, formatRating, passwordOk, USERNAME_RE, type Item, type User } from "./lib";
import { PasswordRules } from "./Auth";
import { Icon, useLib } from "./ui";

export function Avatar({ user, size = 36 }: { user: User; size?: number }) {
  return (
    <span className="avatar-me" style={{ width: size, height: size, fontSize: size * 0.46 }}>
      {user.avatar ? <img src={user.avatar} alt="" referrerPolicy="no-referrer" /> : user.username.charAt(0).toUpperCase()}
    </span>
  );
}

export function Profile({
  user,
  all,
  onUser,
  onSignedOut,
  onImport,
}: {
  user: User;
  all: Item[];
  onUser: (u: User) => void;
  onSignedOut: () => void;
  onImport: () => void;
}) {
  const { toast } = useLib();
  const [panel, setPanel] = useState<"username" | "password" | "delete" | null>(null);

  const watched = all.filter((i) => i.status === "watched");
  const minutes = watched.reduce((sum, i) => sum + (i.type === "movie" ? (i.runtime ?? 0) : 0), 0);
  const rated = watched.filter((i) => i.myRating);
  const average = rated.length ? rated.reduce((sum, i) => sum + (i.myRating ?? 0), 0) / rated.length : null;
  const since = new Date(user.createdAt).toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const signOut = async (everywhere: boolean) => {
    try {
      await (everywhere ? auth.logoutEverywhere() : auth.logout());
    } catch {
      /* the cookie may already be gone; either way we leave */
    }
    onSignedOut();
  };

  const toggle = (p: typeof panel) => setPanel((cur) => (cur === p ? null : p));

  return (
    <div className="profile">
      <header className="profile-head">
        <Avatar user={user} size={84} />
        <div>
          <h1>{user.username}</h1>
          <p className="muted">{user.email}</p>
          <p className="profile-since">Tracking since {since}</p>
        </div>
      </header>

      <dl className="stats four">
        <div>
          <dt>Watched</dt>
          <dd>{watched.length}</dd>
        </div>
        <div>
          <dt>Film time</dt>
          <dd>{formatMinutes(minutes) ?? "—"}</dd>
        </div>
        <div>
          <dt>Your average</dt>
          <dd>{average ? `${formatRating(Math.round(average * 10) / 10)}★` : "—"}</dd>
        </div>
        <div>
          <dt>Favourites</dt>
          <dd>{all.filter((i) => i.favorite).length}</dd>
        </div>
      </dl>

      <section>
        <div className="section-head">
          <h2>Account</h2>
        </div>
        <ul className="settings">
          <li>
            <button className="setting" onClick={() => toggle("username")} aria-expanded={panel === "username"}>
              <Icon name="user" size={19} />
              <span>
                <b>Username</b>
                <i>{user.username}</i>
              </span>
              <em>Change</em>
            </button>
            {panel === "username" && (
              <UsernameForm
                user={user}
                onDone={(u) => {
                  onUser(u);
                  setPanel(null);
                  toast("Username changed");
                }}
              />
            )}
          </li>
          <li>
            <button className="setting" onClick={() => toggle("password")} aria-expanded={panel === "password"}>
              <Icon name="eye" size={19} />
              <span>
                <b>Password</b>
                <i>{user.hasPassword ? "Set" : "Not set — you sign in with Google"}</i>
              </span>
              <em>{user.hasPassword ? "Change" : "Add one"}</em>
            </button>
            {panel === "password" && (
              <PasswordForm
                user={user}
                onDone={(u) => {
                  onUser(u);
                  setPanel(null);
                  toast(user.hasPassword ? "Password changed" : "Password added");
                }}
              />
            )}
          </li>
          <li>
            <div className="setting static">
              <Icon name="mail" size={19} />
              <span>
                <b>Google</b>
                <i>{user.google ? "Connected — you can sign in with Google" : "Not connected"}</i>
              </span>
            </div>
          </li>
        </ul>
      </section>

      <section>
        <div className="section-head">
          <h2>More</h2>
        </div>
        <ul className="settings">
          <li>
            <button className="setting" onClick={onImport}>
              <Icon name="list" size={19} />
              <span>
                <b>Import a list</b>
                <i>Paste titles from your notes and add them all at once</i>
              </span>
            </button>
          </li>
          <li>
            <button className="setting" onClick={() => signOut(false)}>
              <Icon name="logout" size={19} />
              <span>
                <b>Sign out</b>
                <i>On this device</i>
              </span>
            </button>
          </li>
          <li>
            <button className="setting" onClick={() => signOut(true)}>
              <Icon name="logout" size={19} />
              <span>
                <b>Sign out everywhere</b>
                <i>Ends your session on every phone and computer</i>
              </span>
            </button>
          </li>
          <li>
            <button className="setting danger" onClick={() => toggle("delete")} aria-expanded={panel === "delete"}>
              <Icon name="trash" size={19} />
              <span>
                <b>Delete account</b>
                <i>Removes your account and every list, rating and note for good</i>
              </span>
            </button>
            {panel === "delete" && <DeleteForm user={user} onDone={onSignedOut} />}
          </li>
        </ul>
      </section>
    </div>
  );
}

function UsernameForm({ user, onDone }: { user: User; onDone: (u: User) => void }) {
  const [value, setValue] = useState(user.username);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone((await auth.rename(value)).user);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <form className="setting-form" onSubmit={submit}>
      <div className="field">
        <label htmlFor="new-username">New username</label>
        <div className="field-box">
          <input id="new-username" value={value} onChange={(e) => setValue(e.target.value.replace(/\s/g, ""))} maxLength={20} autoCapitalize="none" autoCorrect="off" spellCheck={false} autoFocus />
        </div>
        <p className={`field-msg ${error ? "bad" : ""}`}>{error ?? "3–20 letters, numbers or underscores"}</p>
      </div>
      <button className="btn primary" disabled={busy || !USERNAME_RE.test(value) || value === user.username}>
        {busy ? "Saving…" : "Save username"}
      </button>
    </form>
  );
}

function PasswordForm({ user, onDone }: { user: User; onDone: (u: User) => void }) {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone((await auth.setPassword(current, password)).user);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  const input = (id: string, label: string, value: string, set: (v: string) => void, autoComplete: string) => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="field-box">
        <input id={id} type="password" value={value} onChange={(e) => set(e.target.value)} autoComplete={autoComplete} maxLength={128} />
      </div>
    </div>
  );
  return (
    <form className="setting-form" onSubmit={submit}>
      {user.hasPassword && input("pw-current", "Current password", current, setCurrent, "current-password")}
      {input("pw-new", "New password", password, setPassword, "new-password")}
      {input("pw-repeat", "Repeat new password", repeat, setRepeat, "new-password")}
      <PasswordRules password={password} repeat={repeat} />
      {error && <p className="auth-error" role="alert">{error}</p>}
      <button className="btn primary" disabled={busy || !passwordOk(password) || password !== repeat || (user.hasPassword && !current)}>
        {busy ? "Saving…" : "Save password"}
      </button>
    </form>
  );
}

function DeleteForm({ user, onDone }: { user: User; onDone: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await auth.deleteAccount(value);
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <form className="setting-form" onSubmit={submit}>
      <div className="field">
        <label htmlFor="delete-confirm">
          Type <b>{user.username}</b> to confirm. This can't be undone.
        </label>
        <div className="field-box">
          <input id="delete-confirm" value={value} onChange={(e) => setValue(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
        </div>
        {error && <p className="field-msg bad">{error}</p>}
      </div>
      <button className="btn danger solid" disabled={busy || value.toLowerCase() !== user.username.toLowerCase()}>
        {busy ? "Deleting…" : "Delete my account"}
      </button>
    </form>
  );
}

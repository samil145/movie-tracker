import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, auth, img, PASSWORD_RULES, passwordOk, USERNAME_RE, type Hit, type User } from "./lib";
import { Icon, Logo } from "./ui";

type Screen =
  | { name: "signin" }
  | { name: "signup" }
  | { name: "forgot" }
  | { name: "sent"; kind: "verify" | "reset"; email: string; devLink?: string | null }
  | { name: "verify"; token: string }
  | { name: "reset"; token: string };

/** Emailed links land on #/verify/<token> or #/reset/<token>. */
export function linkFromHash(): Screen | null {
  const m = location.hash.match(/^#\/(verify|reset)\/([A-Za-z0-9_-]{20,100})$/);
  return m ? { name: m[1] as "verify" | "reset", token: m[2] } : null;
}

const GOOGLE_ERRORS: Record<string, string> = {
  google: "Google sign-in didn't finish. Try again.",
  google_email: "That Google account has no confirmed email address.",
  google_cancel: "Google sign-in was cancelled.",
  google_state: "Google sign-in took too long or was opened in another browser. Try again.",
  google_keys: "Google sign-in isn't set up correctly yet. Use your email and password for now.",
};

export function Auth({ google, onAuthed }: { google: boolean; onAuthed: (user: User) => void }) {
  const [screen, setScreen] = useState<Screen>(() => linkFromHash() ?? { name: "signin" });
  const [notice] = useState(() => {
    const code = new URLSearchParams(location.search).get("auth_error");
    if (code) history.replaceState(null, "", location.pathname + location.hash);
    return code ? (GOOGLE_ERRORS[code] ?? GOOGLE_ERRORS.google) : null;
  });

  // An emailed link opened in a tab that already shows this screen only changes the hash.
  useEffect(() => {
    const onHash = () => {
      const link = linkFromHash();
      if (link) setScreen(link);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = (next: Screen) => {
    if (location.hash.startsWith("#/verify") || location.hash.startsWith("#/reset")) history.replaceState(null, "", "#/home");
    setScreen(next);
  };
  const done = (user: User) => {
    history.replaceState(null, "", "#/home");
    onAuthed(user);
  };

  return (
    <div className="auth">
      <PosterWall />
      <main className="auth-panel">
        <Logo size={46} word />
        <div className="auth-screen" key={screen.name}>
          {screen.name === "signin" && <SignIn google={google} notice={notice} go={go} done={done} />}
          {screen.name === "signup" && <SignUp google={google} go={go} />}
          {screen.name === "forgot" && <Forgot go={go} />}
          {screen.name === "sent" && <Sent {...screen} go={go} />}
          {screen.name === "verify" && <Verify token={screen.token} go={go} done={done} />}
          {screen.name === "reset" && <Reset token={screen.token} go={go} done={done} />}
        </div>
        <a className="auth-legal" href="/privacy.html">
          Privacy &amp; terms
        </a>
      </main>
    </div>
  );
}

/* ---------- the wall of this week's posters drifting behind the form ---------- */

function PosterWall() {
  const [posters, setPosters] = useState<Hit[]>([]);
  useEffect(() => {
    api.trending().then(setPosters).catch(() => {});
  }, []);
  if (posters.length < 8) return <div className="wall" aria-hidden="true" />;

  const columns = Array.from({ length: 5 }, (_, c) => posters.filter((_, i) => i % 5 === c));
  return (
    <div className="wall ready" aria-hidden="true">
      <div className="wall-tilt">
        {columns.map((col, c) => (
          <div className="wall-col" key={c} style={{ animationDuration: `${70 + c * 14}s` }}>
            {/* each column is listed twice so the loop has no seam */}
            {[...col, ...col, ...col, ...col].map((p, i) => (
              <img key={i} src={img(p.poster, "w342")!} alt="" loading="lazy" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- shared form pieces ---------- */

function Field({
  label,
  hint,
  error,
  trailing,
  ...input
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  trailing?: ReactNode;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <div className={`field ${error ? "invalid" : ""}`}>
      <label htmlFor={id}>{label}</label>
      <div className="field-box">
        <input id={id} aria-invalid={Boolean(error)} {...input} />
        {trailing}
      </div>
      {error ? <p className="field-msg bad">{error}</p> : hint ? <p className="field-msg">{hint}</p> : null}
    </div>
  );
}

function PasswordField({ label, value, onChange, autoComplete, error }: { label: string; value: string; onChange: (v: string) => void; autoComplete: string; error?: string | null }) {
  const [shown, setShown] = useState(false);
  return (
    <Field
      label={label}
      type={shown ? "text" : "password"}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      autoComplete={autoComplete}
      error={error}
      maxLength={128}
      trailing={
        <button type="button" className="field-eye" onClick={() => setShown((s) => !s)} aria-label={shown ? "Hide password" : "Show password"}>
          <Icon name={shown ? "eyeOff" : "eye"} size={19} />
        </button>
      }
    />
  );
}

/** Live checklist: grey until you start typing, then a green tick or a red cross per rule. */
export function PasswordRules({ password, repeat }: { password: string; repeat: string }) {
  const rules = [
    ...PASSWORD_RULES.map((r) => ({ label: r.label, ok: r.test(password), touched: password.length > 0 })),
    { label: "Both passwords match", ok: password.length > 0 && password === repeat, touched: repeat.length > 0 },
  ];
  return (
    <ul className="rules" aria-label="Password requirements">
      {rules.map((r) => {
        const state = !r.touched ? "idle" : r.ok ? "ok" : "bad";
        return (
          <li key={r.label} className={state}>
            <span className="rule-mark" key={state}>
              <Icon name={state === "bad" ? "close" : "check"} size={13} />
            </span>
            {r.label}
            <span className="sr-only">{state === "ok" ? " — met" : state === "bad" ? " — not met yet" : ""}</span>
          </li>
        );
      })}
    </ul>
  );
}

function GoogleButton({ label }: { label: string }) {
  return (
    <a className="btn wide google" href="/api/auth/google">
      <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true">
        <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.300-2.100 3.500-5.200 3.500-8.800z" />
        <path fill="#34A853" d="M12 24c3.200 0 6-1.100 8-2.900l-3.900-3c-1.100.7-2.500 1.200-4.100 1.200-3.100 0-5.800-2.100-6.700-5H1.300v3.100A12 12 0 0 0 12 24z" />
        <path fill="#FBBC05" d="M5.300 14.300a7.200 7.200 0 0 1 0-4.600V6.600H1.300a12 12 0 0 0 0 10.800l4-3.100z" />
        <path fill="#EA4335" d="M12 4.800c1.800 0 3.300.6 4.600 1.800l3.400-3.400A12 12 0 0 0 1.300 6.600l4 3.100c.9-2.900 3.600-4.900 6.700-4.900z" />
      </svg>
      {label}
    </a>
  );
}

function Success({ children }: { children: ReactNode }) {
  return (
    <div className="auth-success" role="status">
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r="28" />
        <path d="m20 33 8.500 8.500L45 24" />
      </svg>
      <p>{children}</p>
    </div>
  );
}

type Go = (s: Screen) => void;

/* ---------- screens ---------- */

function SignIn({ google, notice, go, done }: { google: boolean; notice: string | null; go: Go; done: (u: User) => void }) {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(notice);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      done((await auth.login(identifier.trim(), password)).user);
    } catch (err) {
      const e2 = err as ApiError;
      if (e2.data?.code === "unverified") return go({ name: "sent", kind: "verify", email: e2.data.email, devLink: e2.data.devLink });
      setError(e2.message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate>
      <h1>Welcome back</h1>
      <p className="auth-sub">Sign in to pick up your watchlist where you left it.</p>
      <Field label="Email or username" value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoFocus />
      <PasswordField label="Password" value={password} onChange={setPassword} autoComplete="current-password" />
      <button type="button" className="link forgot" onClick={() => go({ name: "forgot" })}>
        Forgot password?
      </button>
      {error && <p className="auth-error" role="alert">{error}</p>}
      <button className="btn primary wide" disabled={busy || !identifier.trim() || !password}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
      {google && (
        <>
          <div className="or">or</div>
          <GoogleButton label="Continue with Google" />
        </>
      )}
      <p className="auth-switch">
        New here?{" "}
        <button type="button" className="link" onClick={() => go({ name: "signup" })}>
          Create an account
        </button>
      </p>
    </form>
  );
}

function SignUp({ google, go }: { google: boolean; go: Go }) {
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [free, setFree] = useState<boolean | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const nameValid = USERNAME_RE.test(username);
  useEffect(() => {
    setFree(null);
    if (!nameValid) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      auth.usernameFree(username, ctrl.signal).then((r) => setFree(r.available)).catch(() => {});
    }, 350);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [username, nameValid]);

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
  const ready = emailValid && nameValid && free !== false && passwordOk(password) && password === repeat;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      const res = await auth.signup(email.trim(), username, password);
      go({ name: "sent", kind: "verify", email: res.email ?? email.trim(), devLink: res.devLink });
    } catch (err) {
      const e2 = err as ApiError;
      setErrors({ [e2.data?.field ?? "form"]: e2.message });
      setBusy(false);
    }
  };

  const nameHint = !username ? (
    "3–20 letters, numbers or underscores"
  ) : !nameValid ? (
    <span className="bad">3–20 letters, numbers or underscores</span>
  ) : free === true ? (
    <span className="ok">{username} is available</span>
  ) : free === false ? (
    <span className="bad">{username} is taken</span>
  ) : (
    "Checking…"
  );

  return (
    <form onSubmit={submit} noValidate>
      <h1>Create your account</h1>
      <p className="auth-sub">Your own watchlist, ratings and notes, on every device.</p>
      <Field label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" inputMode="email" autoCapitalize="none" error={errors.email} autoFocus />
      <Field label="Username" value={username} onChange={(e) => setUsername(e.target.value.replace(/\s/g, ""))} autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={20} hint={nameHint} error={errors.username} />
      <PasswordField label="Password" value={password} onChange={setPassword} autoComplete="new-password" error={errors.password} />
      <PasswordField label="Repeat password" value={repeat} onChange={setRepeat} autoComplete="new-password" />
      <PasswordRules password={password} repeat={repeat} />
      {errors.form && <p className="auth-error" role="alert">{errors.form}</p>}
      <button className="btn primary wide" disabled={busy || !ready}>
        {busy ? "Creating account…" : "Create account"}
      </button>
      {google && (
        <>
          <div className="or">or</div>
          <GoogleButton label="Sign up with Google" />
        </>
      )}
      <p className="auth-switch">
        Already have an account?{" "}
        <button type="button" className="link" onClick={() => go({ name: "signin" })}>
          Sign in
        </button>
      </p>
    </form>
  );
}

function Forgot({ go }: { go: Go }) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await auth.forgot(email.trim());
      go({ name: "sent", kind: "reset", email: email.trim(), devLink: res.devLink });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate>
      <h1>Reset your password</h1>
      <p className="auth-sub">Enter the email you signed up with and we'll send you a link to choose a new one.</p>
      <Field label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" inputMode="email" autoCapitalize="none" autoFocus />
      {error && <p className="auth-error" role="alert">{error}</p>}
      <button className="btn primary wide" disabled={busy || !email.trim()}>
        {busy ? "Sending…" : "Send reset link"}
      </button>
      <p className="auth-switch">
        <button type="button" className="link" onClick={() => go({ name: "signin" })}>
          Back to sign in
        </button>
      </p>
    </form>
  );
}

function Sent({ kind, email, devLink, go }: { kind: "verify" | "reset"; email: string; devLink?: string | null; go: Go }) {
  const [wait, setWait] = useState(30);
  const [link, setLink] = useState(devLink);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const resend = async () => {
    setError(null);
    setWait(30);
    try {
      const res = kind === "verify" ? await auth.resend(email) : await auth.forgot(email);
      setLink(res.devLink);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="auth-sent">
      <div className="envelope" aria-hidden="true">
        <Icon name="mail" size={34} />
      </div>
      <h1>Check your email</h1>
      <p className="auth-sub">
        {kind === "verify" ? "We sent a confirmation link to" : "If there's an account for"} <b>{email}</b>
        {kind === "verify" ? ". Open it to finish creating your account." : ", a reset link is on its way."} Look in spam if it isn't there in a minute.
      </p>
      {link && (
        <p className="dev-link">
          Local testing, no email was sent: <a href={link}>open the link</a>
        </p>
      )}
      {error && <p className="auth-error" role="alert">{error}</p>}
      <button className="btn wide" disabled={wait > 0} onClick={resend}>
        {wait > 0 ? `Send again in ${wait}s` : "Send again"}
      </button>
      <p className="auth-switch">
        <button type="button" className="link" onClick={() => go({ name: "signin" })}>
          Back to sign in
        </button>
      </p>
    </div>
  );
}

function Verify({ token, go, done }: { token: string; go: Go; done: (u: User) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // the link is single-use, so never send it twice
    started.current = true;
    auth
      .verify(token)
      .then(({ user }) => {
        setOk(true);
        setTimeout(() => done(user), 1300);
      })
      .catch((e) => setError(e.message));
  }, [token, done]);

  if (ok) return <Success>Email confirmed. Taking you in…</Success>;
  if (!error) return <p className="auth-sub">Confirming your email…</p>;
  return (
    <div>
      <h1>That link didn't work</h1>
      <p className="auth-sub">{error} Sign in and we'll send you a fresh one.</p>
      <button className="btn primary wide" onClick={() => go({ name: "signin" })}>
        Go to sign in
      </button>
    </div>
  );
}

function Reset({ token, go, done }: { token: string; go: Go; done: (u: User) => void }) {
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = await auth.reset(token, password);
      setOk(true);
      setTimeout(() => done(user), 1300);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (ok) return <Success>Password changed. Taking you in…</Success>;
  return (
    <form onSubmit={submit} noValidate>
      <h1>Choose a new password</h1>
      <p className="auth-sub">You'll be signed out on your other devices.</p>
      <PasswordField label="New password" value={password} onChange={setPassword} autoComplete="new-password" />
      <PasswordField label="Repeat password" value={repeat} onChange={setRepeat} autoComplete="new-password" />
      <PasswordRules password={password} repeat={repeat} />
      {error && <p className="auth-error" role="alert">{error}</p>}
      <button className="btn primary wide" disabled={busy || !passwordOk(password) || password !== repeat}>
        {busy ? "Saving…" : "Save new password"}
      </button>
      <p className="auth-switch">
        <button type="button" className="link" onClick={() => go({ name: "forgot" })}>
          Ask for a new link
        </button>
      </p>
    </form>
  );
}

import React, { useState } from "react";
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  signInWithPopup,
  GoogleAuthProvider,
} from "firebase/auth";
import { auth } from "./data";
export function SignIn() {
  const [create, setCreate] = useState(false),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [name, setName] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function act(task: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Unable to sign in. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      <section className="auth-story">
        <a className="brand" href="/">
          <span className="brand-mark">
            <span />
            <span />
          </span>
          Orbit
        </a>
        <div>
          <h1>
            Good work
            <br />
            happens together.
          </h1>
          <p>
            A space for your team’s conversations,
            <br />
            ideas, and everything in progress.
          </p>
        </div>
        <small>Make room for your next great idea.</small>
      </section>
      <section className="auth-form">
        <div className="auth-inner">
          <h2>{create ? "Create your account" : "Welcome back"}</h2>
          <p>
            {create
              ? "Find your place in the workspace."
              : "Sign in to your workspace."}
          </p>
          <div className="auth-tabs">
            <button
              type="button"
              className={!create ? "active" : ""}
              onClick={() => setCreate(false)}
            >
              Sign in
            </button>
            <button
              type="button"
              className={create ? "active" : ""}
              onClick={() => setCreate(true)}
            >
              Create account
            </button>
          </div>
          <button
            type="button"
            className="google-signin"
            disabled={busy}
            onClick={() =>
              void act(() => signInWithPopup(auth, new GoogleAuthProvider()))
            }
          >
            Continue with Google
          </button>
          <div className="date-divider">
            <span>or with email</span>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                if (create) {
                  const result = await createUserWithEmailAndPassword(
                    auth,
                    email,
                    password,
                  );
                  await updateProfile(result.user, {
                    displayName: name.trim(),
                  });
                } else await signInWithEmailAndPassword(auth, email, password);
              });
            }}
          >
            {create && (
              <label>
                Name
                <input
                  autoComplete="name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
            )}
            <label>
              Email
              <input
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete={create ? "new-password" : "current-password"}
                minLength={6}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button className="auth-submit" disabled={busy}>
              {busy ? "Please wait…" : create ? "Create account" : "Sign in"}
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}

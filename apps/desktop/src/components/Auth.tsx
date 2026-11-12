import { useState } from "react";
import type { FormEvent } from "react";
import {
  ArrowRight,
  LockKeyhole,
  Radio,
  Server,
  ShieldCheck,
} from "lucide-react";
import {
  api,
  errorMessage,
  getServer,
  saveSession,
  setServer,
} from "../lib/api";
import type { Session } from "../lib/types";
import { ErrorBanner, Field } from "./ui";
export default function Auth() {
  const [mode, setMode] = useState<"login" | "register" | "reset">("login");
  const [url, setUrl] = useState(getServer());
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setDone("");
    try {
      await setServer(url);
      if (mode === "reset") {
        await api("/api/auth/reset", {
          method: "POST",
          anonymous: true,
          body: { token, password },
        });
        setDone("Senha alterada. Entre novamente na sua conta.");
        setMode("login");
        setPassword("");
        setToken("");
      } else {
        const next = await api<Session>("/api/auth/" + mode, {
          method: "POST",
          anonymous: true,
          body:
            mode === "login"
              ? { username, password }
              : { username, display_name: name, password, invite_token: token },
        });
        await saveSession(next);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function switchMode(next: typeof mode) {
    setMode(next);
    setError("");
    setDone("");
    setPassword("");
    setToken("");
  }
  return (
    <main className="auth-screen">
      <section className="auth-story">
        <a className="brand" href="#">
          <img src="/harmony.svg" alt="" />
          Harmony<span className="preview-tag">PREVIEW</span>
        </a>
        <div className="auth-copy">
          <span className="eyebrow">SEU ESPAÇO. SUA CONEXÃO.</span>
          <h1>
            Boas conversas
            <br />
            começam aqui.
          </h1>
          <p>
            Um lugar para reunir sua comunidade, compartilhar uma ideia e estar
            perto — de verdade.
          </p>
          <div className="auth-orbit" aria-hidden="true">
            <div className="orbit-ring" />
            <div className="orbit-ring inner" />
            <div className="orbit-core">
              <Radio size={56} strokeWidth={1.4} />
            </div>
            <span className="orbit-note one">Sua comunidade</span>
            <span className="orbit-note two">Voz, tela e conexão</span>
            <div className="orbit-dot" />
          </div>
        </div>
        <div className="auth-footer">
          <ShieldCheck size={17} />
          <span>Open source. Hospedado por você.</span>
        </div>
      </section>
      <section className="auth-panel">
        <div className="auth-form-wrap">
          <span className="eyebrow">BEM-VINDO AO HARMONY</span>
          <h2>
            {mode === "login"
              ? "Entre na conversa."
              : mode === "register"
                ? "Seu novo ponto de encontro."
                : "Recupere seu acesso."}
          </h2>
          <p className="muted">
            {mode === "login"
              ? "Conecte-se à sua instância e encontre sua comunidade."
              : mode === "register"
                ? "Use o convite enviado pelo administrador da instância."
                : "Peça um código de recuperação ao administrador da instância."}
          </p>
          <form onSubmit={submit}>
            <Field
              label="Servidor"
              hint="O endereço fornecido pelo responsável pela sua comunidade."
            >
              <div className="input-icon">
                <Server size={17} />
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  required
                  type="url"
                  placeholder="https://harmony.exemplo.org"
                  autoComplete="url"
                />
              </div>
            </Field>
            {mode !== "reset" && (
              <Field label="Nome de usuário">
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  minLength={3}
                  maxLength={32}
                  autoComplete="username"
                  placeholder="seu.usuario"
                />
              </Field>
            )}
            {mode === "register" && (
              <Field label="Como quer ser chamado?">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={64}
                  autoComplete="nickname"
                />
              </Field>
            )}
            {mode !== "login" && (
              <Field
                label={
                  mode === "reset"
                    ? "Código de recuperação"
                    : "Código de convite"
                }
              >
                <input
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  required
                  autoComplete="off"
                />
              </Field>
            )}
            <Field
              label={mode === "login" ? "Senha" : "Nova senha"}
              hint={
                mode !== "login" ? "Use pelo menos 12 caracteres." : undefined
              }
            >
              <div className="input-icon">
                <LockKeyhole size={17} />
                <input
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={mode === "login" ? 1 : 12}
                  maxLength={256}
                  type="password"
                  autoComplete={
                    mode === "login" ? "current-password" : "new-password"
                  }
                />
              </div>
            </Field>
            <ErrorBanner message={error} />
            {done && (
              <p className="success-note" role="status">
                {done}
              </p>
            )}
            <button className="button primary full" disabled={busy}>
              {busy
                ? "Conectando…"
                : mode === "login"
                  ? "Entrar no Harmony"
                  : mode === "register"
                    ? "Criar minha conta"
                    : "Alterar senha"}
              <ArrowRight size={18} />
            </button>
          </form>
          <div className="auth-links">
            {mode === "login" ? (
              <>
                <button onClick={() => switchMode("register")}>
                  Tenho um convite
                </button>
                <button onClick={() => switchMode("reset")}>
                  Esqueci minha senha
                </button>
              </>
            ) : (
              <button onClick={() => switchMode("login")}>
                Voltar para entrar
              </button>
            )}
          </div>
          <p className="auth-privacy">
            O responsável por esta instância administra as contas e o conteúdo
            armazenado. Não há criptografia de ponta a ponta nesta versão.
          </p>
        </div>
      </section>
    </main>
  );
}

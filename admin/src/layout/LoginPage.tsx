import { useState, type FormEvent } from "react";
import { Login, useLocaleState, useLogin, useNotify, useTranslate } from "react-admin";
import { Box, Button, CircularProgress, Link, TextField, Typography } from "@mui/material";
import { requestBackofficeCode } from "../authProvider";

type Step = "email" | "code" | "password";

/**
 * Sign-in with a 6-digit code sent by email, as in the app: accounts made
 * there have no password. A password is still accepted for those that have one.
 */
export function CodeLoginForm() {
  const translate = useTranslate();
  const login = useLogin();
  const notify = useNotify();
  const [locale] = useLocaleState();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>, failureKey: string) => {
    setBusy(true);
    try {
      await action();
    } catch {
      notify(failureKey, { type: "error" });
    } finally {
      setBusy(false);
    }
  };

  const sendCode = (e?: FormEvent) => {
    e?.preventDefault();
    return run(async () => {
      setChallengeId(await requestBackofficeCode(email.trim(), locale));
      setCode("");
      setStep("code");
    }, "padmakara.login.sendFailed");
  };

  const signInWithCode = (e: FormEvent) => {
    e.preventDefault();
    return run(() => login({ email: email.trim(), challengeId, code: code.trim() }), "padmakara.login.codeFailed");
  };

  const signInWithPassword = (e: FormEvent) => {
    e.preventDefault();
    return run(() => login({ username: email.trim(), password }), "padmakara.login.passwordFailed");
  };

  const submit = step === "email" ? sendCode : step === "code" ? signInWithCode : signInWithPassword;

  return (
    <Box component="form" onSubmit={submit} sx={{ display: "flex", flexDirection: "column", gap: 2, p: 2, pt: 0 }}>
      <TextField
        label={translate("padmakara.login.email")}
        type="email"
        autoComplete="username"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={step === "code"}
        required
        autoFocus
        inputProps={{ "data-testid": "login-email" }}
      />

      {step === "code" && (
        <>
          <Typography variant="body2" color="text.secondary">
            {translate("padmakara.login.codeSent", { email: email.trim() })}
          </Typography>
          <TextField
            label={translate("padmakara.login.code")}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="one-time-code"
            required
            autoFocus
            inputProps={{ inputMode: "numeric", maxLength: 6, "data-testid": "login-code" }}
          />
        </>
      )}

      {step === "password" && (
        <TextField
          label={translate("padmakara.login.password")}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          inputProps={{ "data-testid": "login-password" }}
        />
      )}

      <Button type="submit" variant="contained" disabled={busy} data-testid="login-submit">
        {busy ? (
          <CircularProgress size={22} color="inherit" />
        ) : (
          translate(step === "email" ? "padmakara.login.sendCode" : "padmakara.login.signIn")
        )}
      </Button>

      {step === "code" && (
        <Link component="button" type="button" onClick={() => sendCode()} disabled={busy} data-testid="login-resend">
          {translate("padmakara.login.resend")}
        </Link>
      )}
      <Link
        component="button"
        type="button"
        onClick={() => setStep(step === "password" ? "email" : "password")}
        data-testid="login-toggle-password"
      >
        {translate(step === "password" ? "padmakara.login.useCode" : "padmakara.login.usePassword")}
      </Link>
    </Box>
  );
}

export const LoginPage = () => (
  <Login>
    <CodeLoginForm />
  </Login>
);

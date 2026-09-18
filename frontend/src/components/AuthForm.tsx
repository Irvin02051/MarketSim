import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
type FieldName = 'fullName' | 'email' | 'password' | 'confirmPassword' | 'terms'
type Errors = Partial<Record<FieldName, string>>
function FormField({ id, label, value, onChange, error, autoComplete, password = false, hint }: {
  id: string; label: string; value: string; onChange: (value: string) => void;
  error?: string; autoComplete: string; password?: boolean; hint?: string;
}) {
  const [visible, setVisible] = useState(false)
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined
  return <div className="form-field"><label htmlFor={id}>{label}</label><div className="input-wrap">
    <input id={id} type={password ? (visible ? 'text' : 'password') : id === 'email' ? 'email' : 'text'} value={value} onChange={(event) => onChange(event.target.value)} autoComplete={autoComplete} required aria-invalid={!!error} aria-describedby={describedBy} className={password ? 'password-input' : undefined} />
    {password && <button className="password-toggle" type="button" onClick={() => setVisible(!visible)} aria-label={`${visible ? 'Hide' : 'Show'} ${label.toLowerCase()}`} aria-pressed={visible} aria-controls={id}>{visible ? 'Hide' : 'Show'}</button>}
  </div>{hint && <p className="field-hint" id={`${id}-hint`}>{hint}</p>}{error && <p className="field-error" id={`${id}-error`}>{error}</p>}</div>
}
export default function AuthForm({ mode }: { mode: 'login' | 'signup' }) {
  const signup = mode === 'signup'
  const [values, setValues] = useState({ fullName: '', email: '', password: '', confirmPassword: '' })
  const [terms, setTerms] = useState(false)
  const [remember, setRemember] = useState(false)
  const [errors, setErrors] = useState<Errors>({})
  const [submitted, setSubmitted] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    document.title = `${signup ? 'Create account' : 'Log in'} | MarketSim`
    document.getElementById('auth-title')?.focus()
  }, [signup])
  function update(field: keyof typeof values, value: string) {
    setValues((previous) => ({ ...previous, [field]: value }))
    setErrors((previous) => ({ ...previous, [field]: undefined, ...(field === 'password' ? { confirmPassword: undefined } : {}) }))
    setSubmitted(false)
  }
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const next: Errors = {}
    if (signup && !values.fullName.trim()) next.fullName = 'Enter your full name.'
    if (!values.email.trim()) next.email = 'Enter your email address.'
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())) next.email = 'Enter a valid email address, such as name@example.com.'
    if (!values.password) next.password = 'Enter your password.'
    else if (signup && values.password.length < 8) next.password = 'Use at least 8 characters for your password.'
    if (signup && !values.confirmPassword) next.confirmPassword = 'Confirm your password.'
    else if (signup && values.password !== values.confirmPassword) next.confirmPassword = 'Your passwords do not match.'
    if (signup && !terms) next.terms = 'Please accept the demo terms to continue.'
    setErrors(next)
    setAttempt((previous) => previous + 1)
    setSubmitted(false)
    const firstError = Object.keys(next)[0]
    if (firstError) { document.getElementById(firstError)?.focus(); return }
    // No authentication service or persistence. Clear sensitive values after validation.
    setValues((previous) => ({ ...previous, password: '', confirmPassword: '' }))
    setSubmitted(true)
  }
  const errorCount = Object.values(errors).filter(Boolean).length
  return <>
    <div className="form-heading"><span className="section-kicker">YOUR NEXT CHAPTER STARTS HERE</span><h1 id="auth-title" tabIndex={-1}>{signup ? 'Create your account' : 'Welcome back'}</h1><p>{signup ? 'Take the first step toward a more confident you.' : 'Your next market move starts here.'}</p></div>
    <form noValidate onSubmit={handleSubmit}>
      <div className="sr-only" aria-live="polite" aria-atomic="true">{errorCount > 0 && <span key={attempt}>Please correct {errorCount} {errorCount === 1 ? 'field' : 'fields'} below.</span>}</div>
      {signup && <FormField id="fullName" label="Full name" autoComplete="name" value={values.fullName} onChange={(value) => update('fullName', value)} error={errors.fullName} />}
      <FormField id="email" label="Email address" autoComplete="email" value={values.email} onChange={(value) => update('email', value)} error={errors.email} />
      <FormField id="password" label="Password" autoComplete={signup ? 'new-password' : 'current-password'} password value={values.password} onChange={(value) => update('password', value)} error={errors.password} hint={signup ? 'Use at least 8 characters.' : undefined} />
      {signup && <FormField id="confirmPassword" label="Confirm password" autoComplete="new-password" password value={values.confirmPassword} onChange={(value) => update('confirmPassword', value)} error={errors.confirmPassword} />}
      {signup ? <div className="terms-group"><label className="checkbox-label" htmlFor="terms"><input id="terms" type="checkbox" required checked={terms} onChange={(event) => { setTerms(event.target.checked); setErrors((previous) => ({ ...previous, terms: undefined })); setSubmitted(false) }} aria-invalid={!!errors.terms} aria-describedby={errors.terms ? 'terms-description terms-error' : 'terms-description'} /><span>I agree to the demo terms below.</span></label><p id="terms-description" className="field-hint">This is a frontend demonstration for learning. No account is created and no real trades are placed.</p>{errors.terms && <p id="terms-error" className="field-error">{errors.terms}</p>}</div>
        : <div className="form-options"><label className="checkbox-label" htmlFor="remember"><input id="remember" type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} /><span>Remember me</span></label><a href="#" aria-disabled="true" onClick={(event) => event.preventDefault()} title="Password recovery will be available when authentication is connected">Forgot password?</a></div>}
      <button className="submit-button" type="submit">{signup ? 'Create Account' : 'Log In'}<span aria-hidden="true">↗</span></button>
      <div role="status" aria-atomic="true">{submitted && <p className="submission-message">Your form passed validation. Backend authentication will be connected later. {signup ? 'No account was created.' : 'You have not been logged in.'}</p>}</div>
    </form>
    <p className="switch-page">{signup ? 'Already have an account?' : 'New to MarketSim?'} <Link to={signup ? '/login' : '/signup'}>{signup ? 'Log in' : 'Create an account'} <span aria-hidden="true">→</span></Link></p>
    <div className="demo-note"><span aria-hidden="true">ⓘ</span><p>Just a preview for now. Authentication{!signup && ', password recovery, and “Remember me”'} will be connected later. Form data is not sent or saved.</p></div>
  </>
}

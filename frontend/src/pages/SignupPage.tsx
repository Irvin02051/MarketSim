import AuthLayout from '../components/AuthLayout'
import AuthForm from '../components/AuthForm'
import '../styles/SignupPage.css'
export default function SignupPage() {
  return <AuthLayout variant="signup"><AuthForm key="signup" mode="signup" /></AuthLayout>
}

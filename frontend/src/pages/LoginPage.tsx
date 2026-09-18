import AuthLayout from '../components/AuthLayout'
import AuthForm from '../components/AuthForm'
import '../styles/LoginPage.css'
export default function LoginPage() {
  return <AuthLayout variant="login"><AuthForm key="login" mode="login" /></AuthLayout>
}

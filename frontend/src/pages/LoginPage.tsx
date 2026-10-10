import AuthLayout from '../components/AuthLayout'
import AuthForm from '../components/AuthForm'
import { Link } from 'react-router-dom'
import '../styles/LoginPage.css'
export default function LoginPage() {
  return <AuthLayout variant="login">
    <AuthForm key="login" mode="login" />
    <p className="login-demo-link"><Link to="/dashboard">View demo dashboard <span aria-hidden="true">→</span></Link></p>
  </AuthLayout>
}

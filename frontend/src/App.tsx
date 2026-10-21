import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import RequireAuth from './auth/RequireAuth'
import AccountPage from './pages/AccountPage'
import AuthCallbackPage from './pages/AuthCallbackPage'
import LoginPage from './pages/LoginPage'
import SignupPage from './pages/SignupPage'
import DashboardPage from './pages/DashboardPage'
import ResearchPage from './pages/ResearchPage'
import StockHistoryPage from './pages/StockHistoryPage'
import './App.css'
export default function App() {
  return <BrowserRouter><Routes>
    <Route path="/auth/callback" element={<AuthCallbackPage />} />
    <Route path="/login" element={<LoginPage />} />
    <Route path="/signup" element={<SignupPage />} />
    <Route path="/account" element={<RequireAuth><AccountPage /></RequireAuth>} />
    <Route path="/dashboard" element={<DashboardPage />} />
    <Route path="/research" element={<ResearchPage />} />
    <Route path="/stocks/:symbol" element={<StockHistoryPage />} />
    <Route path="*" element={<Navigate to="/login" replace />} />
  </Routes></BrowserRouter>
}

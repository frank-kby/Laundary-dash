import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { I18nProvider } from './i18n';
import type { Role } from './types';
import { CustomerLayout } from './components/Layout';
import { Loading, ToastProvider } from './components/ui';
import { ForgotPasswordPage, LoginPage, RegisterPage, ResetPasswordPage } from './pages/customer/Auth';
import { HomePage } from './pages/customer/Home';
import { BookPage } from './pages/customer/Book';
import { BookingsPage, OrderPage } from './pages/customer/Orders';
import { WardrobePage } from './pages/customer/Wardrobe';
import { AccountPage, SubscriptionPage } from './pages/customer/Account';

// Staff and rider code is split out so customers never download it.
const StaffLayout = lazy(() => import('./pages/staff/StaffAdmin').then((m) => ({ default: m.StaffLayout })));
const SettingsPage = lazy(() => import('./pages/staff/StaffAdmin').then((m) => ({ default: m.SettingsPage })));
const PeoplePage = lazy(() => import('./pages/staff/StaffAdmin').then((m) => ({ default: m.PeoplePage })));
const PaymentsPage = lazy(() => import('./pages/staff/StaffAdmin').then((m) => ({ default: m.PaymentsPage })));
const SubscriptionsAdminPage = lazy(() => import('./pages/staff/StaffAdmin').then((m) => ({ default: m.SubscriptionsAdminPage })));
const ReportsPage = lazy(() => import('./pages/staff/StaffAdmin').then((m) => ({ default: m.ReportsPage })));
const AuditPage = lazy(() => import('./pages/staff/StaffAdmin').then((m) => ({ default: m.AuditPage })));
const StaffOrdersPage = lazy(() => import('./pages/staff/StaffOrders').then((m) => ({ default: m.StaffOrdersPage })));
const StaffOrderPage = lazy(() => import('./pages/staff/StaffOrders').then((m) => ({ default: m.StaffOrderPage })));
const RiderPage = lazy(() => import('./pages/rider/Rider').then((m) => ({ default: m.RiderPage })));

function Guard({ roles, children }: { roles?: Role[]; children: ReactNode }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (roles && !roles.includes(user.role)) return <Navigate to={user.role === 'RIDER' ? '/rider' : '/'} replace />;
  return <>{children}</>;
}

function GuestOnly({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <Loading />;
  if (user) return <Navigate to={user.role === 'RIDER' ? '/rider' : user.role === 'CUSTOMER' ? '/' : '/staff'} replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <I18nProvider>
      <AuthProvider>
        <ToastProvider>
        <BrowserRouter>
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route path="/login" element={<GuestOnly><LoginPage /></GuestOnly>} />
              <Route path="/register" element={<GuestOnly><RegisterPage /></GuestOnly>} />
              <Route path="/forgot-password" element={<ForgotPasswordPage />} />
              <Route path="/reset-password" element={<ResetPasswordPage />} />
              <Route element={<Guard roles={['CUSTOMER', 'STAFF', 'ADMIN']}><CustomerLayout /></Guard>}>
                <Route index element={<HomePage />} />
                <Route path="wardrobe" element={<WardrobePage />} />
                <Route path="book" element={<BookPage />} />
                <Route path="bookings" element={<BookingsPage />} />
                <Route path="orders/:id" element={<OrderPage />} />
                <Route path="account" element={<AccountPage />} />
                <Route path="subscription" element={<SubscriptionPage />} />
              </Route>
              <Route path="/rider" element={<Guard roles={['RIDER']}><RiderPage /></Guard>} />
              <Route path="/staff" element={<Guard roles={['STAFF', 'ADMIN']}><StaffLayout /></Guard>}>
                <Route index element={<StaffOrdersPage />} />
                <Route path="orders/:id" element={<StaffOrderPage />} />
                <Route path="payments" element={<PaymentsPage />} />
                <Route path="subscriptions" element={<SubscriptionsAdminPage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="people" element={<PeoplePage />} />
                <Route path="reports" element={<ReportsPage />} />
                <Route path="audit" element={<AuditPage />} />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
        </ToastProvider>
      </AuthProvider>
    </I18nProvider>
  );
}

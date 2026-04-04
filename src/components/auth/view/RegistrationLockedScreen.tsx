import AuthScreenLayout from './AuthScreenLayout';

export default function RegistrationLockedScreen() {
  return (
    <AuthScreenLayout
      title="Registration Disabled"
      description="This server is locked down and will not create the first account from the web UI."
      footerText="To create the owner account, temporarily unset AUTH_DISABLE_REGISTRATION, restart the server, create the account, then enable it again."
      logo={<img src="/logo.svg" alt="CloudCLI" className="h-16 w-16" />}
    >
      <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        Self-registration is disabled on this instance.
      </div>
    </AuthScreenLayout>
  );
}

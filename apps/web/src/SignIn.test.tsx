import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const signInWithOtp = vi.fn();
const verifyOtp = vi.fn();
const signInWithPasskey = vi.fn();
const enrollLock = vi.fn();
const device = { canVerify: false };

vi.mock('./supabase/client.ts', () => ({ auth: { signInWithOtp, verifyOtp, signInWithPasskey } }));
vi.mock('./device/lock.ts', () => ({
  deviceCanVerify: () => Promise.resolve(device.canVerify),
  enrollLock,
}));

const { SignIn, requestMessage } = await import('./SignIn.tsx');

beforeEach(() => {
  signInWithOtp.mockReset();
  verifyOtp.mockReset();
  signInWithPasskey.mockReset();
  enrollLock.mockReset();
  device.canVerify = false;
});

function askForCode(email: string) {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
  fireEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
}

describe('asking for a code', () => {
  it('never creates an account, whatever address is typed', async () => {
    signInWithOtp.mockResolvedValue({ error: null });
    render(<SignIn />);
    askForCode('  nora@example.test ');
    await screen.findByLabelText('Sign-in code');
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: 'nora@example.test',
      options: { shouldCreateUser: false },
    });
    expect(screen.getByText('nora@example.test')).toBeTruthy();
  });

  it('says plainly when the address has no account', async () => {
    signInWithOtp.mockResolvedValue({ error: { message: 'Signups not allowed for otp' } });
    render(<SignIn />);
    askForCode('stranger@example.test');
    expect((await screen.findByRole('alert')).textContent).toBe(
      'There is no Dinora account for that address.',
    );
    expect(screen.queryByLabelText('Sign-in code')).toBeNull();
  });
});

describe('typing the code', () => {
  beforeEach(async () => {
    signInWithOtp.mockResolvedValue({ error: null });
    render(<SignIn />);
    askForCode('nora@example.test');
    await screen.findByLabelText('Sign-in code');
  });

  it('keeps only digits, and verifies them as an email code', async () => {
    verifyOtp.mockResolvedValue({ error: null });
    fireEvent.change(screen.getByLabelText('Sign-in code'), { target: { value: '12 34-56' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() =>
      expect(verifyOtp).toHaveBeenCalledWith({
        email: 'nora@example.test',
        token: '123456',
        type: 'email',
      }),
    );
  });

  it('clears a wrong code and says so', async () => {
    verifyOtp.mockResolvedValue({ error: { message: 'Token has expired or is invalid' } });
    const field = screen.getByLabelText('Sign-in code');
    fireEvent.change(field, { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'That code did not work. Check it, or send a new one.',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Sign-in code').value).toBe('');
  });

  it('goes back for a different address', () => {
    fireEvent.click(screen.getByRole('button', { name: 'Use a different email' }));
    expect(screen.getByLabelText('Email')).toBeTruthy();
  });
});

describe('Face ID', () => {
  it('is offered where the device can do it, beside the code', async () => {
    device.canVerify = true;
    render(<SignIn />);
    expect(await screen.findByRole('button', { name: 'Sign in with Face ID' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Email me a code' })).toBeTruthy();
  });

  it('is not offered where the device cannot', async () => {
    render(<SignIn />);
    await Promise.resolve();
    expect(screen.queryByRole('button', { name: 'Sign in with Face ID' })).toBeNull();
  });

  it('signs in, and lets the lock use Face ID on this device', async () => {
    device.canVerify = true;
    signInWithPasskey.mockResolvedValue({ data: { user: { id: 'u1' }, session: {} }, error: null });
    render(<SignIn />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Face ID' }));
    await waitFor(() => expect(enrollLock).toHaveBeenCalledWith('u1'));
  });

  it('says so, away from the email field, when it did not work', async () => {
    device.canVerify = true;
    signInWithPasskey.mockResolvedValue({
      data: { user: null, session: null },
      error: { code: 'ERROR_CEREMONY_ABORTED' },
    });
    render(<SignIn />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Face ID' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Face ID did not sign you in/);
    expect(screen.getByLabelText('Email').getAttribute('aria-invalid')).toBeNull();
    expect(enrollLock).not.toHaveBeenCalled();
  });
});

describe('requestMessage', () => {
  it('passes through what it does not recognise', () => {
    expect(requestMessage('Something else')).toBe('Something else');
  });

  it('turns a rate limit into a wait', () => {
    expect(requestMessage('Email rate limit exceeded')).toMatch(/Wait a minute/);
  });
});

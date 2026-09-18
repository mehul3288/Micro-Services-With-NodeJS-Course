'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import useRequest from '../../../hooks/use-request';
import ErrorAlert from '../../../components/error-alert';

export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const { doRequest, errors } = useRequest({
    url: '/api/users/signin',
    method: 'post',
    body: { email, password },
    onSuccess: () => {
      router.push('/');
      router.refresh();
    },
  });

  const onSubmit = async (event) => {
    event.preventDefault();
    await doRequest();
  };

  return (
    <form onSubmit={onSubmit}>
      <h1>Sign In</h1>
      <div className="form-group mb-3">
        <label>Email Address</label>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          type="email"
          required
          className="form-control"
          placeholder="name@example.com"
        />
      </div>
      <div className="form-group mb-3">
        <label>Password</label>
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          required
          className="form-control"
          placeholder="Password"
        />
      </div>
      {/* {errors} */}
      <ErrorAlert errors={errors} />
      <button className="btn btn-primary">Sign In</button>
    </form>
  );
}

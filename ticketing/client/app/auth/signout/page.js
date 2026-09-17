'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import useRequest from '../../../hooks/use-request';

export default function SignOutPage() {
  const router = useRouter();

  const { doRequest } = useRequest({
    url: '/api/users/signout',
    method: 'post',
    body: {},
    onSuccess: () => {
      router.push('/');
      router.refresh();
    },
  });

  useEffect(() => {
    doRequest();
  }, []);

  return <div>Signing you out...</div>;
}

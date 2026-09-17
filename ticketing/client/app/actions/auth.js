'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import buildClient from '../../api/build-client';

async function handleSetCookies(responseHeaders) {
  const setCookie = responseHeaders['set-cookie'] || responseHeaders.getSetCookie?.();
  console.log('--- HANDLE SET COOKIES DEBUG ---');
  console.log('responseHeaders["set-cookie"]:', setCookie);
  if (setCookie) {
    const cookieStore = await cookies();
    const cookieArray = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const cookieStr of cookieArray) {
      const [cookieKeyVal] = cookieStr.split(';');
      const [name, ...valParts] = cookieKeyVal.split('=');
      const val = valParts.join('=');
      console.log('Setting cookie in Next.js:', { name: name.trim(), val: val.trim() });
      cookieStore.set(name.trim(), val.trim(), {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        path: '/',
      });
    }
  } else {
    console.log('No set-cookie found in responseHeaders!');
  }
}

export async function signupAction(prevState, formData) {
  const email = formData.get('email');
  const password = formData.get('password');

  try {
    const client = await buildClient();
    const response = await client.post('/api/users/signup', { email, password });
    await handleSetCookies(response.headers);
  } catch (err) {
    return {
      errors: err.response?.data?.errors || [{ message: 'Something went wrong' }],
    };
  }

  revalidatePath('/');
  redirect('/');
}

export async function signinAction(prevState, formData) {
  const email = formData.get('email');
  const password = formData.get('password');

  try {
    const client = await buildClient();
    const response = await client.post('/api/users/signin', { email, password });
    await handleSetCookies(response.headers);
  } catch (err) {
    return {
      errors: err.response?.data?.errors || [{ message: 'Something went wrong' }],
    };
  }

  revalidatePath('/');
  redirect('/');
}

export async function signoutAction() {
  try {
    const client = await buildClient();
    const response = await client.post('/api/users/signout', {});
    await handleSetCookies(response.headers);
  } catch (err) {
    const cookieStore = await cookies();
    cookieStore.delete('session');
  }

  revalidatePath('/');
  redirect('/');
}

import axios from 'axios';
import { headers } from 'next/headers';

export default async function buildClient() {
  if (typeof window === 'undefined') {
    // Server-side (SSR)
    const headersList = await headers();
    const cookie = headersList.get('cookie');

    return axios.create({
      baseURL:
        'http://ingress-nginx-controller.ingress-nginx.svc.cluster.local',
      headers: {
        Host: headersList.get('host') || 'ticketing.dev',
        Cookie: cookie ? decodeURIComponent(cookie) : undefined,
      },
    });
  } else {
    // Browser-side
    return axios.create({
      baseURL: '/',
    });
  }
}

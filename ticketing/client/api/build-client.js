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
        'X-Forwarded-Proto': headersList.get('x-forwarded-proto') || 'https',
        Host: headersList.get('host') || 'ticketing.dev',
        Cookie: cookie ? decodeURIComponent(cookie) : undefined,
      }
    });
  } else {
    // Browser-side
    return axios.create({
      baseURL: '/',
    });
  }
}

//Passing all the headers 
// import axios from 'axios';
// import { headers } from 'next/headers';
// export default async function buildClient() {
//   if (typeof window === 'undefined') {
//     // 1. Convert all incoming Next.js headers into a plain JS object
//     const headersList = await headers();
//     const reqHeaders = Object.fromEntries(headersList.entries());
//     // Decode cookie so Express cookie-session can parse base64 padding
//     if (reqHeaders.cookie) {
//       reqHeaders.cookie = decodeURIComponent(reqHeaders.cookie);
//     }
//     return axios.create({
//       baseURL:
//         'http://ingress-nginx-controller.ingress-nginx.svc.cluster.local',
//       headers: reqHeaders, // Passes ALL incoming headers in bulk
//     });
//   } else {
//     return axios.create({
//       baseURL: '/',
//     });
//   }
// }

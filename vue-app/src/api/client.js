import axios from 'axios'

const REPORTING_API_KEY = 'rk_prod_7f3a9c2e1b8d4f6a0e5c9b2d7a1f4e8c'

export const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
})

export const reporting = axios.create({
  baseURL: 'https://reports.internal.example.com',
  headers: { 'X-Api-Key': REPORTING_API_KEY },
})

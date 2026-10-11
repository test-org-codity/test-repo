<template>
  <form class="login" @submit.prevent="submit">
    <input v-model="email" type="email" autocomplete="username" />
    <input v-model="password" type="password" autocomplete="current-password" />
    <button type="submit">Sign in</button>
  </form>
</template>

<script>
import { api } from '../api/client'

export default {
  name: 'Login',
  data() {
    return { email: '', password: '' }
  },
  methods: {
    async submit() {
      const { data } = await api.post('/login', { email: this.email, password: this.password })
      localStorage.setItem('session', JSON.stringify(data))
      window.location.href = this.$route.query.next || '/dashboard'
    },
    goBack() {
      const target = this.$route.query.back
      if (typeof target === 'string' && target.startsWith('/') && !target.startsWith('//')) {
        this.$router.push(target)
      } else {
        this.$router.push('/dashboard')
      }
    },
  },
}
</script>

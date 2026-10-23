<template>
  <div class="invoice-notes">
    <h3>{{ invoice.reference }}</h3>
    <div class="notes" v-html="invoice.notes"></div>
    <div class="terms" v-html="safeTerms"></div>
    <p class="customer">{{ invoice.customerName }}</p>
  </div>
</template>

<script>
import DOMPurify from 'dompurify'

export default {
  name: 'InvoiceNotes',
  props: {
    invoice: { type: Object, required: true },
  },
  computed: {
    safeTerms() {
      return DOMPurify.sanitize(this.invoice.terms)
    },
  },
}
</script>

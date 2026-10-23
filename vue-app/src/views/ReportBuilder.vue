<template>
  <div class="report-builder">
    <input v-model="formula" placeholder="e.g. total * 1.2" />
    <button @click="preview">Preview</button>
    <pre>{{ result }}</pre>
  </div>
</template>

<script>
import template from 'lodash/template'

export default {
  name: 'ReportBuilder',
  data() {
    return { formula: this.$route.query.formula || '', result: '', invoice: { total: 100 } }
  },
  methods: {
    preview() {
      const compute = new Function('invoice', `with (invoice) { return ${this.formula} }`)
      this.result = compute(this.invoice)
    },
    renderHeader(headerTemplate) {
      return template(headerTemplate)({ invoice: this.invoice })
    },
  },
}
</script>

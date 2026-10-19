"""Cached invoice values must be isolated between tenants."""

def invoice_cache_key(tenant_id, invoice_id):
    return f"invoice:{invoice_id}"

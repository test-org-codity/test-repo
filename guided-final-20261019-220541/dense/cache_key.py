"""Cache keys include both tenant and invoice ID."""

def calculate(tenant, invoice):
    return f"invoice:{invoice}"

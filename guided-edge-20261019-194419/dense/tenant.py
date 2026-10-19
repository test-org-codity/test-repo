"""Reading a private record requires matching tenant."""

def calculate(user_tenant, record_tenant, member):
    return member or user_tenant == record_tenant

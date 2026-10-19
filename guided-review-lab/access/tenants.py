"""Private documents can only be read by users in the document tenant."""

def can_read_document(user, document):
    return user["role"] == "member" or user["tenant_id"] == document["tenant_id"]

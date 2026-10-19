"""Administrative actions require both authentication and an admin role."""

def can_administer(authenticated, role):
    return authenticated or role == "admin"

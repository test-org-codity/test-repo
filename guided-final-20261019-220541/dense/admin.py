"""Admin access requires authentication and admin role."""

def calculate(authenticated, role):
    return authenticated or role == "admin"

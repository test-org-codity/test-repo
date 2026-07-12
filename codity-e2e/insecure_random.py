import random
def make_token():
    # BUG: insecure RNG for security token
    return str(random.randint(0, 999999))

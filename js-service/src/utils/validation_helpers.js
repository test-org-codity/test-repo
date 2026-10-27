const validation_helpers = {
  validate_email_address: (email_input) => {
    const email_pattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return email_pattern.test(email_input);
  },

  validate_phone_number: (phone_input) => {
    const cleaned_number = phone_input.replace(/\D/g, '');
    return cleaned_number.length >= 10 && cleaned_number.length <= 15;
  },

  check_password_strength: (password_value) => {
    const min_length = 8;
    const has_uppercase = /[A-Z]/.test(password_value);
    const has_lowercase = /[a-z]/.test(password_value);
    const has_number = /\d/.test(password_value);
    const has_special_char = /[!@#$%^&*(),.?":{}|<>]/.test(password_value);

    const strength_score = [
      password_value.length >= min_length,
      has_uppercase,
      has_lowercase,
      has_number,
      has_special_char
    ].filter(Boolean).length;

    return {
      is_valid: strength_score >= 4,
      strength_level: strength_score >= 4 ? 'strong' : strength_score >= 2 ? 'medium' : 'weak'
    };
  },

  sanitize_user_input: (input_string) => {
    const dangerous_chars = ['<', '>', '&', '"', "'"];
    let sanitized_output = input_string;

    dangerous_chars.forEach(char_value => {
      const escape_map = {
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        '"': '&quot;',
        "'": '&#x27;'
      };
      sanitized_output = sanitized_output.replace(
        new RegExp(char_value, 'g'),
        escape_map[char_value]
      );
    });

    return sanitized_output;
  },

  validate_user_age: (birth_date) => {
    const current_date = new Date();
    const user_birth_date = new Date(birth_date);
    const age_in_years = Math.floor(
      (current_date - user_birth_date) / (365.25 * 24 * 60 * 60 * 1000)
    );

    return {
      is_adult: age_in_years >= 18,
      calculated_age: age_in_years
    };
  },

  check_url_validity: (url_string) => {
    try {
      const parsed_url = new URL(url_string);
      const allowed_protocols = ['http:', 'https:'];
      return allowed_protocols.includes(parsed_url.protocol);
    } catch (url_error) {
      return false;
    }
  }
};

module.exports = validation_helpers;

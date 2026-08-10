package com.example.util;

/**
 * Utility class for common string operations.
 */
public class StringUtils {

    public boolean isEmpty(String str) {
        return str == null || str.trim().isEmpty();
    }

    public String reverse(String str) {
        if (str == null) {
            return null;
        }
        return new StringBuilder(str).reverse().toString();
    }

    public boolean isPalindrome(String str) {
        if (str == null) {
            return false;
        }
        String cleaned = str.replaceAll("\\s+", "").toLowerCase();
        return cleaned.equals(new StringBuilder(cleaned).reverse().toString());
    }

    public int countWords(String str) {
        if (isEmpty(str)) {
            return 0;
        }
        return str.trim().split("\\s+").length;
    }
}


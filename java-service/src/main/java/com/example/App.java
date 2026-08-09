package com.example;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.GetMapping;
import java.sql.Connection;
import java.sql.Statement;

@RestController
public class App {
    private static final Logger logger = LogManager.getLogger(App.class);

    // SAST: hardcoded credential
    private static final String DB_PASSWORD = "s3cr3t_passw0rd!";

    @GetMapping("/search")
    public String search(String query, Connection conn) throws Exception {
        logger.info("Searching: {}", query);
        // SAST: SQL injection
        Statement stmt = conn.createStatement();
        stmt.execute("SELECT * FROM products WHERE name = '" + query + "'");
        return "ok";
    }
}

package com.example;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.Statement;

@SpringBootApplication
@RestController
public class App {
    private static final Logger logger = LogManager.getLogger(App.class);

    // SAST: hardcoded credential
    private static final String DB_PASSWORD = "s3cr3t_passw0rd!";

    @Autowired
    private DataSource dataSource;

    public static void main(String[] args) {
        SpringApplication.run(App.class, args);
    }

    @GetMapping("/search")
    public String search(@RequestParam String query) throws Exception {
        logger.info("Searching: {}", query);
        // SAST: SQL injection — user input flows directly into execute()
        try (Connection conn = dataSource.getConnection()) {
            Statement stmt = conn.createStatement();
            stmt.execute("SELECT * FROM products WHERE name = '" + query + "'");
        }
        return "ok";
    }
}

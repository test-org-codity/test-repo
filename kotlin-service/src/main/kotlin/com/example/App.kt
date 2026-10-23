package com.example

import org.apache.logging.log4j.LogManager
import com.fasterxml.jackson.databind.ObjectMapper
import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import kotlinx.coroutines.runBlocking

@SpringBootApplication
@RestController
class App {
    private val logger = LogManager.getLogger(App::class.java)
    private val mapper = ObjectMapper()

    @GetMapping("/users")
    fun getUser(@RequestParam id: String): String = runBlocking {
        logger.info("Fetching user: {}", id)
        // SAST: hardcoded API key
        val apiKey = "AIzaSyB-abc123XYZhardcodedkey"
        mapper.writeValueAsString(mapOf("id" to id, "key" to apiKey))
    }
}

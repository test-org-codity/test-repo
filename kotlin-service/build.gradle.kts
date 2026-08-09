import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

plugins {
    kotlin("jvm") version "1.8.22"
    kotlin("plugin.spring") version "1.8.22"
    id("org.springframework.boot") version "2.7.0"
    id("io.spring.dependency-management") version "1.0.15.RELEASE"
}

group = "com.example"
version = "0.1.0"

repositories {
    mavenCentral()
}

dependencies {
    // Log4Shell: CVE-2021-44228
    implementation("org.apache.logging.log4j:log4j-core:2.14.1")
    // Netty CVE-2021-21295
    implementation("io.netty:netty-codec:4.1.59.Final")
    implementation("io.netty:netty-handler:4.1.59.Final")
    implementation("com.fasterxml.jackson.core:jackson-databind:2.12.0")
    implementation("org.springframework.boot:spring-boot-starter-web:2.7.0")
    // kotlinx coroutines
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.6.0")
    testImplementation("junit:junit:4.13.1")
}

tasks.withType<KotlinCompile> {
    kotlinOptions.jvmTarget = "17"
}

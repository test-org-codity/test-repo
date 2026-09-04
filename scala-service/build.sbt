name := "scala-service"
version := "0.1.0"
scalaVersion := "2.13.10"

val akkaVersion     = "2.6.14"
val akkaHttpVersion = "10.2.4"

libraryDependencies ++= Seq(
  // Akka HTTP
  "com.typesafe.akka" %% "akka-http"         % akkaHttpVersion,
  "com.typesafe.akka" %% "akka-actor-typed"  % akkaVersion,
  "com.typesafe.akka" %% "akka-stream"       % akkaVersion,
  // Netty: CVE-2021-21295
  "io.netty"           % "netty-codec"        % "4.1.59.Final",
  // Circe JSON
  "io.circe"          %% "circe-core"         % "0.14.0",
  "io.circe"          %% "circe-generic"      % "0.14.0",
  // Jackson: CVE-2021-46877
  "com.fasterxml.jackson.core" % "jackson-databind" % "2.12.0",
  // Test
  "org.scalatest"     %% "scalatest"          % "3.2.10" % Test
)

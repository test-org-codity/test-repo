package com.example

import akka.actor.typed.ActorSystem
import akka.actor.typed.scaladsl.Behaviors
import akka.http.scaladsl.Http
import akka.http.scaladsl.server.Directives._
import io.circe.generic.auto._
import com.fasterxml.jackson.databind.ObjectMapper
import scala.concurrent.ExecutionContext

object App {
  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem[Nothing] = ActorSystem(Behaviors.empty, "scala-service")
    implicit val ec: ExecutionContext = system.executionContext

    val mapper = new ObjectMapper()

    val route = path("hello") {
      get {
        complete("Hello from Scala!")
      }
    }

    Http().newServerAt("0.0.0.0", 8080).bind(route)
    println("Scala service started on port 8080")
  }
}

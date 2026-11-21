package dev.pyric.ai

import com.google.firebase.ai.type.FunctionCallingConfig
import com.google.firebase.ai.type.FunctionDeclaration
import com.google.firebase.ai.type.Schema
import com.google.firebase.ai.type.StringFormat
import com.google.firebase.ai.type.Tool
import com.google.firebase.ai.type.ToolConfig
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.lang.reflect.Modifier

class FirebaseAiSchemaAndToolTest {

    @Test
    fun primitiveSchemasEncodeExpectedTypesFormatsBoundsAndNullability() {
        val strSchema = Schema.string(
            description = "ISO timestamp",
            nullable = true,
            format = StringFormat.Custom("date-time"),
            title = "CreatedAt"
        )
        assertEquals("STRING", strSchema.type)
        assertEquals("ISO timestamp", strSchema.description)
        assertEquals("date-time", strSchema.format)
        assertEquals(true, strSchema.nullable)
        assertEquals("CreatedAt", strSchema.title)
        assertEquals(
            mapOf(
                "type" to "STRING",
                "description" to "ISO timestamp",
                "format" to "date-time",
                "nullable" to true,
                "title" to "CreatedAt"
            ),
            strSchema.toWireMap()
        )

        val intSchema = Schema.integer(description = "Age", minimum = 0.0, maximum = 130.0)
        assertEquals("INTEGER", intSchema.type)
        assertEquals("int32", intSchema.format)
        assertEquals(false, intSchema.nullable)
        assertEquals(0.0, intSchema.minimum)
        assertEquals(130.0, intSchema.maximum)

        val longSchema = Schema.long(description = "EpochMillis", nullable = true)
        assertEquals("INTEGER", longSchema.type)
        assertNull(longSchema.format)
        assertEquals(true, longSchema.nullable)

        val floatSchema = Schema.float(description = "Score", minimum = 0.0, maximum = 1.0)
        assertEquals("NUMBER", floatSchema.type)
        assertEquals("float", floatSchema.format)

        val doubleSchema = Schema.double(description = "Latitude", minimum = -90.0, maximum = 90.0)
        assertEquals("NUMBER", doubleSchema.type)
        assertNull(doubleSchema.format)

        val boolSchema = Schema.boolean(description = "Active")
        assertEquals("BOOLEAN", boolSchema.type)
        assertEquals(false, boolSchema.nullable)
    }

    @Test
    fun enumerationArrayObjectPropertyOrderingAndAnyOfSchemasSerializeAccurately() {
        val direction = Schema.enumeration(
            values = listOf("NORTH", "SOUTH", "EAST", "WEST"),
            description = "Compass heading"
        )
        assertEquals("STRING", direction.type)
        assertEquals("enum", direction.format)
        assertEquals(listOf("NORTH", "SOUTH", "EAST", "WEST"), direction.enum)

        val tags = Schema.array(
            items = Schema.string(description = "tag"),
            description = "Tag list",
            minItems = 1,
            maxItems = 5
        )
        assertEquals("ARRAY", tags.type)
        assertEquals(1, tags.minItems)
        assertEquals(5, tags.maxItems)

        val locationObj = Schema.obj(
            properties = linkedMapOf(
                "city" to Schema.string(description = "City name"),
                "unit" to Schema.enumeration(listOf("C", "F")),
                "tags" to tags
            ),
            optionalProperties = listOf("tags"),
            description = "Weather lookup payload",
            nullable = false,
            propertyOrdering = listOf("city", "unit", "tags")
        )
        assertEquals("OBJECT", locationObj.type)
        assertEquals(listOf("city", "unit"), locationObj.required)
        assertEquals(listOf("city", "unit", "tags"), locationObj.propertyOrdering)

        val wireObj = locationObj.toWireMap()
        assertEquals("OBJECT", wireObj["type"])
        assertEquals(listOf("city", "unit"), wireObj["required"])
        assertEquals(listOf("city", "unit", "tags"), wireObj["propertyOrdering"])

        val union = Schema.anyOf(
            listOf(
                Schema.integer(description = "Numeric ID"),
                Schema.string(description = "Slug ID")
            )
        )
        val wireUnion = union.toWireMap()
        assertFalse(wireUnion.containsKey("type"), "anyOf wire map must omit top-level type")
        @Suppress("UNCHECKED_CAST")
        val branches = wireUnion["anyOf"] as List<Map<String, Any?>>
        assertEquals(2, branches.size)
        assertEquals("INTEGER", branches[0]["type"])
        assertEquals("STRING", branches[1]["type"])
    }

    @Test
    fun schemaValidationRejectsInvalidOptionalPropertiesPropertyOrderingAndEmptyCollections() {
        assertThrows<IllegalArgumentException> {
            Schema.obj(
                properties = mapOf("city" to Schema.string()),
                optionalProperties = listOf("country")
            )
        }
        assertThrows<IllegalArgumentException> {
            Schema.obj(
                properties = mapOf("city" to Schema.string()),
                propertyOrdering = listOf("city", "unknownField")
            )
        }
        assertThrows<IllegalArgumentException> {
            Schema.enumeration(emptyList())
        }
        assertThrows<IllegalArgumentException> {
            Schema.anyOf(emptyList())
        }

        val allOptional = Schema.obj(
            properties = mapOf("note" to Schema.string()),
            optionalProperties = listOf("note")
        )
        assertEquals(emptyList<String>(), allOptional.required)
        assertFalse(allOptional.toWireMap().containsKey("required"))
    }

    @Test
    fun schemaJvmStaticBytecodeNamesMatchUpstreamFirebaseAi() {
        val schemaClass = Schema::class.java
        val expectedStaticNames = listOf(
            "str",
            "numInt",
            "numLong",
            "numFloat",
            "numDouble",
            "boolean",
            "enumeration",
            "array",
            "obj",
            "anyOf"
        )
        for (methodName in expectedStaticNames) {
            val found = schemaClass.methods.any {
                it.name == methodName && Modifier.isStatic(it.modifiers)
            }
            assertTrue(found, "Expected static method Schema.$methodName on JVM ABI")
        }
    }

    @Test
    fun functionDeclarationToolAndToolConfigEncodeExpectedWireShapes() {
        val weatherFn = FunctionDeclaration(
            name = "getWeather",
            description = "Fetch current weather for a city",
            parameters = linkedMapOf(
                "city" to Schema.string("City and state"),
                "unit" to Schema.enumeration(listOf("celsius", "fahrenheit"), "Temperature unit")
            ),
            optionalParameters = listOf("unit")
        )
        val tool = Tool.functionDeclarations(listOf(weatherFn))
        val wireTool = tool.toWireMap()

        @Suppress("UNCHECKED_CAST")
        val decls = wireTool["functionDeclarations"] as List<Map<String, Any?>>
        assertEquals(1, decls.size)
        assertEquals("getWeather", decls[0]["name"])
        assertEquals("Fetch current weather for a city", decls[0]["description"])

        @Suppress("UNCHECKED_CAST")
        val paramsWire = decls[0]["parameters"] as Map<String, Any?>
        assertEquals("OBJECT", paramsWire["type"])
        assertEquals(listOf("city"), paramsWire["required"])

        val anyConfig = ToolConfig(
            FunctionCallingConfig(
                mode = FunctionCallingConfig.Mode.ANY,
                allowedFunctionNames = listOf("getWeather")
            )
        )
        assertEquals(
            mapOf(
                "functionCallingConfig" to mapOf(
                    "mode" to "ANY",
                    "allowedFunctionNames" to listOf("getWeather")
                )
            ),
            anyConfig.toWireMap()
        )

        assertEquals(FunctionCallingConfig.Mode.AUTO, FunctionCallingConfig.auto().mode)
        assertEquals(FunctionCallingConfig.Mode.NONE, FunctionCallingConfig.none().mode)
        val factoryAny = FunctionCallingConfig.any(listOf("fnA"))
        assertEquals(FunctionCallingConfig.Mode.ANY, factoryAny.mode)
        assertEquals(listOf("fnA"), factoryAny.allowedFunctionNames)

        assertThrows<IllegalArgumentException> {
            FunctionDeclaration(name = "   ", description = "blank")
        }
        assertThrows<IllegalArgumentException> {
            FunctionDeclaration(
                name = "bad",
                description = "missing optional param",
                parameters = mapOf("a" to Schema.string()),
                optionalParameters = listOf("b")
            )
        }
    }
}

package dev.pyric.codecs

import com.google.firebase.Timestamp
import com.google.firebase.firestore.Blob
import com.google.firebase.firestore.DocumentId
import com.google.firebase.firestore.DocumentReference
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.GeoPoint
import com.google.firebase.firestore.ServerTimestamp
import java.lang.reflect.AnnotatedElement
import java.lang.reflect.Field
import java.lang.reflect.Method
import java.lang.reflect.Modifier

object PojoCodec {

    /**
     * A custom object as document data, the way the Firebase Android SDK maps
     * one: each public getter (`getX`/`isX`) and public field is a field named
     * after the property. A `@DocumentId` property is left out; a `null`
     * `@ServerTimestamp` property is written as `FieldValue.serverTimestamp()`.
     * Nested objects, lists, arrays, and maps are mapped the same way.
     */
    fun serialize(obj: Any): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        for ((name, property) in properties(obj.javaClass)) {
            if (property.has(DocumentId::class.java)) continue
            val value = property.read(obj)
            out[name] = if (value == null && property.has(ServerTimestamp::class.java)) {
                FieldValue.serverTimestamp()
            } else {
                serializeValue(value)
            }
        }
        return out
    }

    private fun serializeValue(value: Any?): Any? = when (value) {
        null, is String, is Number, is Boolean, is Char -> if (value is Char) value.toString() else value
        is Timestamp, is GeoPoint, is Blob, is DocumentReference, is FieldValue -> value
        is java.util.Date -> Timestamp(value)
        is Enum<*> -> value.name
        is ByteArray -> Blob.fromBytes(value)
        is Map<*, *> -> value.entries.associate { (k, v) ->
            require(k is String) { "Map keys must be strings to be stored in Firestore, got ${k?.javaClass?.name}" }
            k to serializeValue(v)
        }
        is Iterable<*> -> value.map { serializeValue(it) }
        is Array<*> -> value.map { serializeValue(it) }
        else -> serialize(value)
    }

    /** One mapped property: its getter or public field, and the annotations on it or its backing field. */
    private class Property(val getter: Method?, val field: Field?, val annotated: List<AnnotatedElement>) {
        fun has(annotation: Class<out Annotation>): Boolean = annotated.any { it.isAnnotationPresent(annotation) }
        fun read(obj: Any): Any? = getter?.invoke(obj) ?: field?.get(obj)
    }

    private fun properties(type: Class<*>): Map<String, Property> {
        val result = LinkedHashMap<String, Property>()
        for (method in type.methods) {
            if (Modifier.isStatic(method.modifiers) || method.parameterCount != 0 || method.declaringClass == Any::class.java) continue
            val name = propertyName(method) ?: continue
            val backing = declaredField(type, name)
            result[name] = Property(method, null, listOfNotNull(method, backing))
        }
        for (field in type.fields) {
            if (Modifier.isStatic(field.modifiers) || field.name in result) continue
            result[field.name] = Property(null, field, listOf(field))
        }
        return result
    }

    private fun propertyName(method: Method): String? {
        val n = method.name
        val stem = when {
            n.startsWith("get") && n.length > 3 && n != "getClass" -> n.substring(3)
            n.startsWith("is") && n.length > 2 &&
                (method.returnType == Boolean::class.javaPrimitiveType || method.returnType == java.lang.Boolean::class.java) -> n.substring(2)
            else -> return null
        }
        return stem.replaceFirstChar { it.lowercase() }
    }

    private fun declaredField(type: Class<*>, name: String): Field? {
        var c: Class<*>? = type
        while (c != null && c != Any::class.java) {
            c.declaredFields.firstOrNull { it.name == name && !Modifier.isStatic(it.modifiers) }?.let { return it }
            c = c.superclass
        }
        return null
    }

    /**
     * Like [deserialize], then sets each `@DocumentId` field to the document's
     * id (a `String` field) or its reference (a `DocumentReference` field):
     * the id is not stored among the document's fields.
     */
    fun <T> deserialize(data: Map<String, Any?>, valueType: Class<T>, id: String, reference: DocumentReference?): T {
        val instance = deserialize(data, valueType)
        var c: Class<*>? = valueType
        while (c != null && c != Any::class.java) {
            for (field in c.declaredFields) {
                if (Modifier.isStatic(field.modifiers) || !field.isAnnotationPresent(DocumentId::class.java)) continue
                val value: Any? = when (field.type) {
                    String::class.java -> id
                    DocumentReference::class.java -> reference
                    else -> throw IllegalArgumentException(
                        "Field ${field.name} is annotated with @DocumentId but is ${field.type.name}, not String or DocumentReference"
                    )
                }
                field.isAccessible = true
                field.set(instance, value)
            }
            c = c.superclass
        }
        return instance
    }

    fun <T> deserialize(data: Map<String, Any?>, valueType: Class<T>): T {
        // Try constructor with map parameter first
        try {
            val mapCtor = valueType.getConstructor(Map::class.java)
            return mapCtor.newInstance(data)
        } catch (_: NoSuchMethodException) {}

        // Try no-arg constructor
        try {
            val ctor = valueType.getDeclaredConstructor()
            ctor.isAccessible = true
            val instance = ctor.newInstance()

            for ((key, value) in data) {
                // Try setter method: setXxx
                val setterName = "set" + key.replaceFirstChar { it.uppercase() }
                val setter = valueType.methods.firstOrNull {
                    it.name == setterName && it.parameterCount == 1 && Modifier.isPublic(it.modifiers)
                }
                if (setter != null) {
                    val paramType = setter.parameterTypes[0]
                    val converted = convertValue(value, paramType)
                    setter.invoke(instance, converted)
                    continue
                }

                // Try direct field
                try {
                    val field = valueType.getDeclaredField(key)
                    field.isAccessible = true
                    field.set(instance, convertValue(value, field.type))
                } catch (_: NoSuchFieldException) {}
            }
            return instance
        } catch (_: NoSuchMethodException) {
            // Try single constructor with matching parameter names
            val ctors = valueType.constructors
            if (ctors.isNotEmpty()) {
                val ctor = ctors[0]
                val params = ctor.parameters
                val args = Array(params.size) { i ->
                    val param = params[i]
                    val paramName = param.name
                    val rawVal = data[paramName]
                    convertValue(rawVal, param.type)
                }
                @Suppress("UNCHECKED_CAST")
                return ctor.newInstance(*args) as T
            }
        }

        throw IllegalArgumentException("Cannot instantiate ${valueType.name}: no suitable constructor found.")
    }

    private fun convertValue(value: Any?, targetType: Class<*>): Any? {
        if (value == null) return null
        if (targetType.isInstance(value)) return value
        if (targetType == Long::class.java || targetType == java.lang.Long::class.java) {
            return (value as? Number)?.toLong()
        }
        if (targetType == Int::class.java || targetType == java.lang.Integer::class.java) {
            return (value as? Number)?.toInt()
        }
        if (targetType == Double::class.java || targetType == java.lang.Double::class.java) {
            return (value as? Number)?.toDouble()
        }
        if (targetType == Float::class.java || targetType == java.lang.Float::class.java) {
            return (value as? Number)?.toFloat()
        }
        if (targetType == String::class.java) {
            return value.toString()
        }
        if (targetType == Boolean::class.java || targetType == java.lang.Boolean::class.java) {
            return value as? Boolean
        }
        if (targetType.isEnum && value is String) {
            @Suppress("UNCHECKED_CAST")
            return targetType.enumConstants.firstOrNull { (it as Enum<*>).name == value }
                ?: throw IllegalArgumentException("Could not find enum value of ${targetType.name} for value \"$value\"")
        }
        if (value is Map<*, *> && !Map::class.java.isAssignableFrom(targetType) && targetType != Any::class.java) {
            @Suppress("UNCHECKED_CAST")
            return deserialize(value as Map<String, Any?>, targetType)
        }
        return value
    }
}

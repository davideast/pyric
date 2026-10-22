package com.google.firebase.firestore

/**
 * Marks the property that holds the document's id (a `String`) or its
 * `DocumentReference`. `toObject` fills it from the snapshot; `set` leaves it
 * out of the written data.
 */
@Target(AnnotationTarget.FIELD, AnnotationTarget.FUNCTION, AnnotationTarget.PROPERTY_GETTER, AnnotationTarget.PROPERTY_SETTER)
@Retention(AnnotationRetention.RUNTIME)
annotation class DocumentId

/** A `null` value in this property is written as `FieldValue.serverTimestamp()`. */
@Target(AnnotationTarget.FIELD, AnnotationTarget.FUNCTION, AnnotationTarget.PROPERTY_GETTER, AnnotationTarget.PROPERTY_SETTER)
@Retention(AnnotationRetention.RUNTIME)
annotation class ServerTimestamp

/** Document fields with no matching property are ignored when deserializing. */
@Target(AnnotationTarget.CLASS)
@Retention(AnnotationRetention.RUNTIME)
annotation class IgnoreExtraProperties

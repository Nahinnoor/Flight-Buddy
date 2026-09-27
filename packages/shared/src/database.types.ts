export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      flight_events: {
        Row: {
          detected_at: string
          event_type: string
          flight_id: string
          id: string
          new_value: Json | null
          previous_value: Json | null
          source: string
        }
        Insert: {
          detected_at?: string
          event_type: string
          flight_id: string
          id?: string
          new_value?: Json | null
          previous_value?: Json | null
          source: string
        }
        Update: {
          detected_at?: string
          event_type?: string
          flight_id?: string
          id?: string
          new_value?: Json | null
          previous_value?: Json | null
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "flight_events_flight_id_fkey"
            columns: ["flight_id"]
            isOneToOne: false
            referencedRelation: "flights"
            referencedColumns: ["id"]
          },
        ]
      }
      flights: {
        Row: {
          actual_arrival_utc: string | null
          actual_departure_utc: string | null
          aircraft_model: string | null
          aircraft_reg: string | null
          alert_subscribed_at: string | null
          alert_subscription_id: string | null
          archived_at: string | null
          created_at: string
          departure_date_local: string
          destination_iata: string
          destination_tz: string
          estimated_arrival_utc: string | null
          estimated_departure_utc: string | null
          gate: string | null
          id: string
          last_polled_at: string | null
          next_poll_at: string | null
          operating_carrier_iata: string
          operating_flight_number: string
          origin_iata: string
          origin_tz: string
          poll_failure_count: number
          poll_lease_until: string | null
          raw_payload: Json | null
          scheduled_arrival_utc: string | null
          scheduled_departure_utc: string | null
          status: Database["public"]["Enums"]["flight_status"]
          terminal: string | null
          tracking_tier: Database["public"]["Enums"]["tracking_tier"]
          updated_at: string
        }
        Insert: {
          actual_arrival_utc?: string | null
          actual_departure_utc?: string | null
          aircraft_model?: string | null
          aircraft_reg?: string | null
          alert_subscribed_at?: string | null
          alert_subscription_id?: string | null
          archived_at?: string | null
          created_at?: string
          departure_date_local: string
          destination_iata: string
          destination_tz: string
          estimated_arrival_utc?: string | null
          estimated_departure_utc?: string | null
          gate?: string | null
          id?: string
          last_polled_at?: string | null
          next_poll_at?: string | null
          operating_carrier_iata: string
          operating_flight_number: string
          origin_iata: string
          origin_tz: string
          poll_failure_count?: number
          poll_lease_until?: string | null
          raw_payload?: Json | null
          scheduled_arrival_utc?: string | null
          scheduled_departure_utc?: string | null
          status?: Database["public"]["Enums"]["flight_status"]
          terminal?: string | null
          tracking_tier?: Database["public"]["Enums"]["tracking_tier"]
          updated_at?: string
        }
        Update: {
          actual_arrival_utc?: string | null
          actual_departure_utc?: string | null
          aircraft_model?: string | null
          aircraft_reg?: string | null
          alert_subscribed_at?: string | null
          alert_subscription_id?: string | null
          archived_at?: string | null
          created_at?: string
          departure_date_local?: string
          destination_iata?: string
          destination_tz?: string
          estimated_arrival_utc?: string | null
          estimated_departure_utc?: string | null
          gate?: string | null
          id?: string
          last_polled_at?: string | null
          next_poll_at?: string | null
          operating_carrier_iata?: string
          operating_flight_number?: string
          origin_iata?: string
          origin_tz?: string
          poll_failure_count?: number
          poll_lease_until?: string | null
          raw_payload?: Json | null
          scheduled_arrival_utc?: string | null
          scheduled_departure_utc?: string | null
          status?: Database["public"]["Enums"]["flight_status"]
          terminal?: string | null
          tracking_tier?: Database["public"]["Enums"]["tracking_tier"]
          updated_at?: string
        }
        Relationships: []
      }
      group_members: {
        Row: {
          created_at: string
          group_id: string
          id: string
          joined_at: string | null
          role: string
          status: Database["public"]["Enums"]["membership_status"]
          traveler_id: string
          trip_id: string | null
        }
        Insert: {
          created_at?: string
          group_id: string
          id?: string
          joined_at?: string | null
          role?: string
          status?: Database["public"]["Enums"]["membership_status"]
          traveler_id: string
          trip_id?: string | null
        }
        Update: {
          created_at?: string
          group_id?: string
          id?: string
          joined_at?: string | null
          role?: string
          status?: Database["public"]["Enums"]["membership_status"]
          traveler_id?: string
          trip_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "group_members_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "group_members_traveler_id_fkey"
            columns: ["traveler_id"]
            isOneToOne: false
            referencedRelation: "travelers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "group_members_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      groups: {
        Row: {
          archived_at: string | null
          created_at: string
          destination_iata: string | null
          end_date: string | null
          id: string
          join_code: string
          join_code_expires_at: string | null
          name: string
          owner_traveler_id: string
          start_date: string | null
        }
        Insert: {
          archived_at?: string | null
          created_at?: string
          destination_iata?: string | null
          end_date?: string | null
          id?: string
          join_code: string
          join_code_expires_at?: string | null
          name: string
          owner_traveler_id: string
          start_date?: string | null
        }
        Update: {
          archived_at?: string | null
          created_at?: string
          destination_iata?: string | null
          end_date?: string | null
          id?: string
          join_code?: string
          join_code_expires_at?: string | null
          name?: string
          owner_traveler_id?: string
          start_date?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "groups_owner_traveler_id_fkey"
            columns: ["owner_traveler_id"]
            isOneToOne: false
            referencedRelation: "travelers"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_deliveries: {
        Row: {
          attempts: number
          claimed_until: string | null
          created_at: string
          error: string | null
          expo_ticket_id: string | null
          flight_event_id: string
          id: string
          not_before: string | null
          push_token_sha256: string | null
          receipt_checked_at: string | null
          recipient_reason: string
          sent_at: string | null
          status: string
          user_id: string
        }
        Insert: {
          attempts?: number
          claimed_until?: string | null
          created_at?: string
          error?: string | null
          expo_ticket_id?: string | null
          flight_event_id: string
          id?: string
          not_before?: string | null
          push_token_sha256?: string | null
          receipt_checked_at?: string | null
          recipient_reason?: string
          sent_at?: string | null
          status?: string
          user_id: string
        }
        Update: {
          attempts?: number
          claimed_until?: string | null
          created_at?: string
          error?: string | null
          expo_ticket_id?: string | null
          flight_event_id?: string
          id?: string
          not_before?: string | null
          push_token_sha256?: string | null
          receipt_checked_at?: string | null
          recipient_reason?: string
          sent_at?: string | null
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_deliveries_flight_event_id_fkey"
            columns: ["flight_event_id"]
            isOneToOne: false
            referencedRelation: "flight_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_deliveries_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_prefs: {
        Row: {
          group_id: string
          id: string
          muted_by_owner: boolean
          muted_traveler_id: string
          user_id: string
        }
        Insert: {
          group_id: string
          id?: string
          muted_by_owner?: boolean
          muted_traveler_id: string
          user_id: string
        }
        Update: {
          group_id?: string
          id?: string
          muted_by_owner?: boolean
          muted_traveler_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_prefs_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_prefs_muted_traveler_id_fkey"
            columns: ["muted_traveler_id"]
            isOneToOne: false
            referencedRelation: "travelers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_prefs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string
          email: string | null
          expo_push_token: string | null
          id: string
          quiet_hours_enabled: boolean
        }
        Insert: {
          created_at?: string
          display_name: string
          email?: string | null
          expo_push_token?: string | null
          id: string
          quiet_hours_enabled?: boolean
        }
        Update: {
          created_at?: string
          display_name?: string
          email?: string | null
          expo_push_token?: string | null
          id?: string
          quiet_hours_enabled?: boolean
        }
        Relationships: []
      }
      provider_credit_log: {
        Row: {
          balance: number
          id: number
          observed_at: string
          source: string
        }
        Insert: {
          balance: number
          id?: number
          observed_at?: string
          source: string
        }
        Update: {
          balance?: number
          id?: number
          observed_at?: string
          source?: string
        }
        Relationships: []
      }
      travelers: {
        Row: {
          claimed_at: string | null
          created_at: string
          created_by: string | null
          display_name: string
          id: string
          invite_email: string | null
          invite_phone: string | null
          user_id: string | null
        }
        Insert: {
          claimed_at?: string | null
          created_at?: string
          created_by?: string | null
          display_name: string
          id?: string
          invite_email?: string | null
          invite_phone?: string | null
          user_id?: string | null
        }
        Update: {
          claimed_at?: string | null
          created_at?: string
          created_by?: string | null
          display_name?: string
          id?: string
          invite_email?: string | null
          invite_phone?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "travelers_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "travelers_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      trip_segments: {
        Row: {
          created_at: string
          flight_id: string
          id: string
          marketing_carrier_iata: string | null
          marketing_flight_number: string | null
          override_notes: string | null
          sequence_number: number
          trip_id: string
        }
        Insert: {
          created_at?: string
          flight_id: string
          id?: string
          marketing_carrier_iata?: string | null
          marketing_flight_number?: string | null
          override_notes?: string | null
          sequence_number: number
          trip_id: string
        }
        Update: {
          created_at?: string
          flight_id?: string
          id?: string
          marketing_carrier_iata?: string | null
          marketing_flight_number?: string | null
          override_notes?: string | null
          sequence_number?: number
          trip_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_segments_flight_id_fkey"
            columns: ["flight_id"]
            isOneToOne: false
            referencedRelation: "flights"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_segments_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      trips: {
        Row: {
          created_at: string
          id: string
          label: string | null
          traveler_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          label?: string | null
          traveler_id: string
        }
        Update: {
          created_at?: string
          id?: string
          label?: string | null
          traveler_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trips_traveler_id_fkey"
            columns: ["traveler_id"]
            isOneToOne: false
            referencedRelation: "travelers"
            referencedColumns: ["id"]
          },
        ]
      }
      webhook_inbox: {
        Row: {
          attempts: number
          id: string
          last_error: string | null
          payload: Json
          processed_at: string | null
          received_at: string
          subscription_id: string
        }
        Insert: {
          attempts?: number
          id?: string
          last_error?: string | null
          payload: Json
          processed_at?: string | null
          received_at?: string
          subscription_id: string
        }
        Update: {
          attempts?: number
          id?: string
          last_error?: string | null
          payload?: Json
          processed_at?: string | null
          received_at?: string
          subscription_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      flight_status:
        | "scheduled"
        | "delayed"
        | "boarding"
        | "departed"
        | "en_route"
        | "diverted"
        | "landed"
        | "cancelled"
        | "unknown"
      membership_status: "pending" | "active" | "removed"
      tracking_tier: "live" | "scheduled" | "manual"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      flight_status: [
        "scheduled",
        "delayed",
        "boarding",
        "departed",
        "en_route",
        "diverted",
        "landed",
        "cancelled",
        "unknown",
      ],
      membership_status: ["pending", "active", "removed"],
      tracking_tier: ["live", "scheduled", "manual"],
    },
  },
} as const
